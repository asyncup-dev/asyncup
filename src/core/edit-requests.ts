import { DateTime } from 'luxon';
import type { ChatAdapter } from './adapter.js';
import type { Mention } from './commands.js';
import { can, resolveAccess } from './permissions.js';
import type { Actor } from './schedule.js';
import type { StandupService } from './standup-service.js';
import type { EditRequest, EditRequestStatus, Run, Standup } from './types.js';
import type { Repo } from '../db/repo.js';

/** A request with what its cards and the web app show around it. */
export interface EditRequestView extends Omit<EditRequest, 'userName' | 'displayName' | 'cardMessages'> {
  standup: Standup;
  date: string;
  person: Mention;
  /** When the answer was first posted. */
  answeredAt: string;
  /** When the window closes, as people read it: "23:59 Europe/London". */
  until: string;
}

/** How a prompt card shows someone's request, if they made one. */
export interface EditState {
  status: EditRequestStatus;
  by: string | null;
  until: string;
}

export type EditResult = { ok: true; message: string; request?: EditRequestView } | { ok: false; message: string; request?: EditRequestView };

/** Midnight after the run's day in the standup's timezone: late answers and approved edits stop then. */
export function dayEnd(standup: Standup, run: Run): DateTime {
  return DateTime.fromISO(run.date, { zone: standup.timezone }).plus({ days: 1 }).startOf('day');
}

export const untilLabel = (standup: Standup) => `23:59 ${standup.timezone}`;
export const dayLabel = (date: string) => DateTime.fromISO(date).setLocale('en-GB').toFormat('ccc d LLL');
export const closedText = (run: Run) => `This standup has closed. Answers for ${dayLabel(run.date)} can no longer be added.`;

/**
 * Changing answers after the deadline, with a manager's approval. Asking
 * sends the standup's managers a card; the first decision wins and redraws
 * every card. Approved edits, and undecided requests, end at midnight.
 */
export class EditRequests {
  constructor(
    private repo: Repo,
    private adapter: ChatAdapter,
    private service: StandupService,
    private now: () => DateTime,
    private log: (msg: string) => void,
  ) {}

  dayOver(standup: Standup, run: Run): boolean {
    return this.now() >= dayEnd(standup, run);
  }

  /** Whether an answer to a closed run may change now. */
  async canEdit(standup: Standup, run: Run, userName: string): Promise<boolean> {
    if (this.dayOver(standup, run)) return false;
    return (await this.repo.getEditRequestFor(run.id, userName))?.status === 'approved';
  }

  /** Why someone can't ask, or null when they can. */
  async askRefusal(standup: Standup, run: Run, userName: string): Promise<string | null> {
    if (this.dayOver(standup, run)) return closedText(run);
    if (run.status === 'open') return 'The deadline hasn’t passed, so you can still edit your answers.';
    if (!(await this.repo.getSubmission(run.id, userName))) return 'You haven’t answered yet, so there is nothing to edit. Answers can still be added late, until midnight.';
    const existing = await this.repo.getEditRequestFor(run.id, userName);
    if (!existing) return null;
    if (existing.status === 'pending') return 'Your request is waiting for a manager.';
    if (existing.status === 'approved') return `${existing.decidedBy} approved your request. Edit your answers before ${untilLabel(standup)}.`;
    return `${existing.decidedBy} declined your request, so you can’t ask again for ${dayLabel(run.date)}.`;
  }

  async ask(runId: number, person: Mention, reason: string | null): Promise<EditResult> {
    const run = await this.repo.getRunById(runId);
    if (!run) return { ok: false, message: 'This standup prompt is no longer valid.' };
    const standup = (await this.repo.getStandupById(run.standupId))!;
    const refusal = await this.askRefusal(standup, run, person.userName);
    if (refusal) return { ok: false, message: refusal };
    const request = await this.repo.createEditRequest({ runId: run.id, userName: person.userName, displayName: person.displayName, reason: reason?.trim() || null, askedAt: this.now().toISO()! });
    const view = await this.view(request);
    const managers = (await this.repo.listAdmins(standup.id)).filter((a) => a.userName !== person.userName);
    const cards: string[] = [];
    for (const manager of managers) {
      try {
        const name = await this.adapter.sendEditRequest(manager.userName, view);
        if (name) cards.push(name);
      } catch (err) {
        this.log(`edit request to ${manager.userName} failed: ${err}`);
      }
    }
    await this.repo.setEditRequestCards(request.id, cards);
    await this.service.refreshCards(standup, run, person.userName);
    return {
      ok: true,
      message: managers.length ? '📨 Sent to your managers. You’ll hear back here.' : '📨 Sent. Nobody else manages this standup in Chat, so an admin decides in the web app.',
    };
  }

  /**
   * A manager approves or declines. `actor.admin` means the caller's right to
   * decide was already checked (the API does that); nobody decides their own.
   */
  async decide(id: number, approve: boolean, actor: Actor, note: string | null): Promise<EditResult> {
    const request = await this.repo.getEditRequest(id);
    if (!request) return { ok: false, message: 'That request no longer exists.' };
    const run = (await this.repo.getRunById(request.runId))!;
    const standup = (await this.repo.getStandupById(run.standupId))!;
    if (request.status === 'pending' && this.dayOver(standup, run)) await this.lapseOne(request, standup, run);
    const settled = await this.settled(id);
    if (settled) return settled;
    if (request.userName === actor.userName) return { ok: false, message: 'Your own requests go to your managers.' };
    if (!actor.admin) {
      const access = await resolveAccess(this.repo, { tenantId: standup.tenantId, userName: actor.userName }, false);
      if (!can(access, 'standups.configure', standup.id)) return { ok: false, message: `Only the managers of ${standup.name} can decide this.` };
    }
    const decided = await this.repo.decideEditRequest(id, approve ? 'approved' : 'declined', this.now().toISO()!, actor, note);
    if (!decided) return (await this.settled(id))!;
    const view = await this.view((await this.repo.getEditRequest(id))!);
    await this.redraw(request, view);
    try {
      if (approve) await this.adapter.sendEditApproved(request.userName, view);
      else await this.adapter.sendDm(request.userName, `❌ ${actor.displayName} declined your request to edit your answers for ${dayLabel(run.date)}.${note ? ` “${note}”` : ''}`);
    } catch (err) {
      this.log(`telling ${request.userName} about their edit request failed: ${err}`);
    }
    await this.service.refreshCards(standup, run, request.userName);
    const message = approve ? `✅ Approved. ${request.displayName} can edit until ${untilLabel(standup)}.` : `❌ Declined. ${request.displayName} has been told.`;
    return { ok: true, message, request: view };
  }

  /** Requests nobody decided before midnight lapse; safe to run every tick. */
  async lapse(): Promise<void> {
    for (const request of await this.repo.listPendingEditRequests()) {
      const run = await this.repo.getRunById(request.runId);
      if (!run) continue;
      const standup = (await this.repo.getStandupById(run.standupId))!;
      if (this.dayOver(standup, run)) await this.lapseOne(request, standup, run);
    }
  }

  /** Pending requests, newest first, for the web app and API. */
  async listPending(): Promise<EditRequestView[]> {
    const views: EditRequestView[] = [];
    for (const request of await this.repo.listPendingEditRequests()) views.push(await this.view(request));
    return views;
  }

  async getView(id: number): Promise<EditRequestView | null> {
    const request = await this.repo.getEditRequest(id);
    return request ? this.view(request) : null;
  }

  /** How someone's prompt card shows their request. */
  async stateFor(standup: Standup, run: Run, userName: string): Promise<EditState | null> {
    const request = await this.repo.getEditRequestFor(run.id, userName);
    return request ? { status: request.status, by: request.decidedBy, until: untilLabel(standup) } : null;
  }

  private async lapseOne(request: EditRequest, standup: Standup, run: Run): Promise<void> {
    if (!(await this.repo.decideEditRequest(request.id, 'lapsed', this.now().toISO()!, null, null))) return;
    await this.redraw(request, await this.view((await this.repo.getEditRequest(request.id))!));
    try {
      await this.adapter.sendDm(request.userName, `⌛ Your request to edit your answers for ${dayLabel(run.date)} wasn’t answered that day, so it lapsed. Your answers stay as they were.`);
    } catch (err) {
      this.log(`telling ${request.userName} their edit request lapsed failed: ${err}`);
    }
    await this.service.refreshCards(standup, run, request.userName);
  }

  /** The answer for a request that is no longer pending, or null while it is. */
  private async settled(id: number): Promise<EditResult | null> {
    const request = (await this.repo.getEditRequest(id))!;
    if (request.status === 'pending') return null;
    const view = await this.view(request);
    if (request.status === 'lapsed') return { ok: false, message: 'That request lapsed at midnight.', request: view };
    return { ok: false, message: `${request.decidedBy} already ${request.status} this request.`, request: view };
  }

  private async redraw(request: EditRequest, view: EditRequestView): Promise<void> {
    if (request.cardMessages.length === 0) return;
    try {
      await this.adapter.updateEditRequestCards(request.cardMessages, view);
    } catch (err) {
      this.log(`redrawing edit request ${request.id} failed: ${err}`);
    }
  }

  private async view(request: EditRequest): Promise<EditRequestView> {
    const run = (await this.repo.getRunById(request.runId))!;
    const standup = (await this.repo.getStandupById(run.standupId))!;
    const submission = await this.repo.getSubmission(run.id, request.userName);
    const { userName, displayName, cardMessages: _cards, ...rest } = request;
    return { ...rest, standup, date: run.date, person: { userName, displayName }, answeredAt: submission?.submittedAt ?? request.askedAt, until: untilLabel(standup) };
  }
}
