import { IANAZone } from 'luxon';
import type { BlockerService } from '../../core/blocker-service.js';
import type { CommandHandler, Mention } from '../../core/commands.js';
import type { PollService } from '../../core/poll-service.js';
import type { StandupService } from '../../core/standup-service.js';
import { describeDates, parseDateSpec, type ScheduleService } from '../../core/schedule.js';
import type { Repo } from '../../db/repo.js';
import {
  isBlockerQuestion,
  MOODS,
  standupQuestions,
  type Answer,
  type Mood,
} from '../../core/types.js';
import {
  ACK_BLOCKER_FN,
  APPROVE_REQUEST_FN,
  DECLINE_REQUEST_FN,
  SUBMIT_DECLINE_FN,
  declineDialog,
  blockerUpdateDialog,
  OPEN_BLOCKER_UPDATE_FN,
  OPEN_DIALOG_FN,
  pollMessage,
  RESOLVE_BLOCKER_FN,
  SKIP_TODAY_FN,
  standupDialog,
  SUBMIT_BLOCKER_UPDATE_FN,
  SUBMIT_DIALOG_FN,
  VOTE_POLL_FN,
} from './cards.js';

/**
 * Routes Google Chat interaction events (MESSAGE, CARD_CLICKED, dialog
 * submits) to the core, and shapes the synchronous JSON response.
 * Event reference: https://developers.google.com/workspace/chat/receive-respond-interactions
 */
export class EventRouter {
  constructor(
    private commands: CommandHandler,
    private service: StandupService,
    private blockers: BlockerService,
    private repo: Repo,
    private tenantId: string,
    private polls: PollService | null = null,
    /** The app's events URL when known — add-on builds address card clicks to it. */
    private endpoint: () => Promise<string | null> = async () => null,
    private schedule: ScheduleService | null = null,
  ) {}

  async handle(event: any): Promise<object> {
    // Learn user emails from any interaction — needed for calendar OOO lookups.
    if (event?.user?.name && event.user.email) {
      await this.repo.setUserEmail(event.user.name, event.user.email);
    }
    switch (event?.type) {
      case 'ADDED_TO_SPACE':
        return this.onAddedToSpace(event);
      case 'MESSAGE':
        return this.onMessage(event);
      case 'CARD_CLICKED':
        return this.onCardClicked(event);
      default:
        return {};
    }
  }

  private onAddedToSpace(event: any): object {
    if (isDm(event)) {
      return {
        text: "👋 Hi! When your team's standup is due you'll get a card here with a *Fill standup* button. DM me `vacation` / `back` to toggle your vacation mode, or `timezone <IANA>` to get prompts in your own timezone.",
      };
    }
    return {
      text: '👋 Thanks for adding me! Mention me with `setup` to create a standup that reports to this space, or `help` for all commands.',
    };
  }

  private async onMessage(event: any): Promise<object> {
    const user = eventUser(event);
    if (isDm(event)) {
      return this.onDirectMessage(event, user);
    }
    const text: string = event.message?.argumentText ?? event.message?.text ?? '';
    const reply = await this.commands.handle({
      tenantId: this.tenantId,
      spaceName: event.space?.name ?? '',
      text,
      mentions: extractMentions(event),
      sender: user,
    });
    return { text: reply };
  }

  private async onDirectMessage(event: any, user: Mention): Promise<object> {
    const raw = (event.message?.argumentText ?? event.message?.text ?? '').trim();
    const text = raw.toLowerCase();
    if (text === 'timezone' || text.startsWith('timezone ')) {
      return this.onTimezoneDm(user, raw.split(/\s+/)[1] ?? '');
    }
    if (text === 'vacation' || text === 'ooo') {
      const affected = await this.repo.setVacationForUser(user.userName, true);
      return {
        text: affected
          ? `🏖️ Vacation mode ON across ${affected} standup${affected === 1 ? '' : 's'} — you won't be prompted or counted as missing. DM me \`back\` when you return.`
          : "You're not on any standup roster yet.",
      };
    }
    if (text === 'back') {
      const affected = await this.repo.setVacationForUser(user.userName, false);
      return {
        text: affected
          ? `👋 Welcome back! Vacation mode is off — prompts resume with the next run.`
          : "You're not on any standup roster yet.",
      };
    }
    if (this.schedule && /^(off|working|days)(\s|$)/.test(text)) {
      return { text: await this.onScheduleDm(user, raw) };
    }
    return {
      text:
        'When a standup is due you\'ll get a card here with a *Fill standup* button.\n' +
        'DM commands: `vacation` (pause prompts while you\'re away) · `back` (resume) · ' +
        '`off <date|range> [reason]` (a day off, e.g. `off tomorrow comp off`) · `working <date>` · `off list` · `off cancel <date>` · ' +
        '`days mon-thu|adhoc|reset` (your own week) · ' +
        '`timezone <IANA>` (get your prompts at the standup time in *your* zone; `timezone reset` to follow the standup zone).\n' +
        'Team configuration happens in the team space — mention me with `help` there.',
    };
  }

  /** DM `off` / `working` / `days` — the person's own schedule, under their standups' time-off policy. */
  private async onScheduleDm(user: Mention, raw: string): Promise<string> {
    const schedule = this.schedule!;
    const [verb, ...rest] = raw.trim().split(/\s+/);
    const command = verb!.toLowerCase();
    const text = rest.join(' ');
    const standups = await this.repo.listStandupsForUser(user.userName);
    const zone = standups[0]?.timezone ?? 'UTC';
    const now = schedule.nowIn(zone);
    const actor = { userName: user.userName, displayName: user.displayName, self: true, manager: (await this.repo.listStandupsAdministeredBy(user.userName)).length > 0 };
    if (command === 'days') return (await schedule.setWorkingDays(user, text, actor, 'chat')).message;
    if (command === 'off' && /^list\b/i.test(text)) {
      const upcoming = await schedule.listUpcoming(user.userName, zone);
      if (upcoming.length === 0) return 'Nothing coming up — your usual week applies. `off <date>` to mark a day off.';
      const lines = upcoming.map((o) => `• ${describeDates([o.date])} · ${o.working ? 'working' : 'off'}${o.reason ? ` (${o.reason})` : ''}${o.status === 'active' ? '' : ` · ${o.status}`}`);
      return `Coming up:\n${lines.join('\n')}`;
    }
    if (command === 'off' && /^cancel\b/i.test(text)) {
      const spec = parseDateSpec(text.replace(/^cancel\s*/i, ''), now);
      if (!spec.ok) return spec.message;
      return (await schedule.cancelOverride(user, spec.dates[0]!, actor)).message;
    }
    const spec = parseDateSpec(text, now);
    if (!spec.ok) return spec.message;
    const result = await schedule.setOverride({ target: user, dates: spec.dates, working: command === 'working', reason: spec.rest, actor, channel: 'chat' });
    return result.message;
  }

  /** DM `timezone` — personal prompt timezone across all the user's standups. */
  private async onTimezoneDm(user: Mention, arg: string): Promise<object> {
    if (!arg) {
      const current = await this.repo.getUserTimezone(user.userName);
      return {
        text: current
          ? `Your prompts follow *${current}*. \`timezone <IANA>\` to change, \`timezone reset\` to follow each standup's timezone.`
          : 'Your prompts follow each standup\'s timezone. Set your own with `timezone <IANA>`, e.g. `timezone Asia/Kolkata`.',
      };
    }
    if (arg.toLowerCase() === 'reset' || arg.toLowerCase() === 'off') {
      const affected = await this.repo.setTimezoneForUser(user.userName, null);
      return {
        text: affected
          ? '✅ Personal timezone cleared — prompts follow each standup\'s timezone again.'
          : "You're not on any standup roster yet.",
      };
    }
    if (!IANAZone.isValidZone(arg)) {
      return { text: `\`${arg}\` is not a valid IANA timezone — try e.g. \`timezone Asia/Kolkata\` or \`timezone Europe/Berlin\`.` };
    }
    const affected = await this.repo.setTimezoneForUser(user.userName, arg);
    return {
      text: affected
        ? `✅ Prompts will reach you at the standup's prompt time in *${arg}*. Deadlines stay in the standup's timezone.`
        : "You're not on any standup roster yet.",
    };
  }

  private async onCardClicked(event: any): Promise<object> {
    // Add-on builds carry the action name as a parameter (the function is the URL).
    const fn = getParameter(event, 'fn') ?? event.common?.invokedFunction;
    const runId = Number(getParameter(event, 'runId'));
    const user = eventUser(event);

    if (fn === OPEN_DIALOG_FN) {
      if (!Number.isInteger(runId)) return dialogError('This standup prompt is no longer valid.');
      const run = await this.repo.getRunById(runId);
      if (!run) return dialogError('This standup prompt is no longer valid.');
      const standup = (await this.repo.getStandupById(run.standupId))!;
      const prefill = await this.service.getPrefill(standup, run, user.userName);
      return standupDialog(runId, standupQuestions(standup), standup.moodEnabled, prefill, await this.endpoint());
    }

    if (fn === SUBMIT_DIALOG_FN) {
      return this.onDialogSubmit(event, runId, user);
    }

    if (fn === SKIP_TODAY_FN) {
      const result = await this.service.skipToday(runId, user.userName);
      const messages = {
        skipped: "🏖️ Skipped today's standup — you won't be counted as missing. Have a good one!",
        already_submitted: '✅ You already submitted today, so there is nothing to skip.',
        not_found: 'This standup prompt is no longer valid.',
      };
      return { actionResponse: { type: 'UPDATE_MESSAGE' }, text: messages[result] };
    }

    if (fn === VOTE_POLL_FN && this.polls) {
      const pollId = Number(getParameter(event, 'pollId'));
      const optionIndex = Number(getParameter(event, 'optionIndex'));
      const result = await this.polls.vote(pollId, user, optionIndex);
      if (result.status !== 'ok') {
        const messages = {
          closed: 'This poll is closed.',
          not_found: 'This poll no longer exists.',
          bad_option: 'That option no longer exists.',
        };
        return { actionResponse: { type: 'NEW_MESSAGE' }, text: messages[result.status] };
      }
      // Replace the clicked card with fresh tallies — no extra API call needed.
      return { actionResponse: { type: 'UPDATE_MESSAGE' }, ...pollMessage(result.poll, result.tallies, false, await this.endpoint()) };
    }

    if ((fn === APPROVE_REQUEST_FN || fn === DECLINE_REQUEST_FN || fn === SUBMIT_DECLINE_FN) && this.schedule) {
      const ids = String(getParameter(event, 'requestIds') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (fn === DECLINE_REQUEST_FN) return declineDialog(ids.join(','), await this.endpoint());
      const decision = { userName: user.userName, displayName: user.displayName, admin: false };
      if (fn === APPROVE_REQUEST_FN) return { text: (await this.schedule.decide(ids, true, decision, null)).message };
      const note = getFormValue(event, 'note').trim() || null;
      const result = await this.schedule.decide(ids, false, decision, note);
      return result.ok ? dialogOk(result.message) : dialogError(result.message);
    }

    const blockerId = Number(getParameter(event, 'blockerId'));

    if (fn === ACK_BLOCKER_FN) {
      const result = await this.blockers.acknowledge(blockerId, user);
      const messages = {
        acked: '✋ Acknowledged — the reporter has been told you are on it. Use the buttons above to post updates or resolve.',
        already_acked: 'You already acknowledged this blocker.',
        not_tagged: "You aren't tagged on this blocker.",
        not_found: 'This blocker is already resolved or no longer exists.',
      };
      return { text: messages[result] };
    }

    if (fn === OPEN_BLOCKER_UPDATE_FN) {
      if (!Number.isInteger(blockerId)) return dialogError('This blocker card is no longer valid.');
      return blockerUpdateDialog(blockerId, await this.endpoint());
    }

    if (fn === SUBMIT_BLOCKER_UPDATE_FN) {
      const text = getFormValue(event, 'update').trim();
      if (!text) return dialogError('Please write the update first.');
      const result = await this.blockers.addUpdate(blockerId, user, text);
      const messages = {
        ok: '📝 Update posted — everyone involved was notified.',
        resolved: 'This blocker is already resolved.',
        not_found: 'This blocker no longer exists.',
      };
      return result === 'ok' ? dialogOk(messages.ok) : dialogError(messages[result]);
    }

    if (fn === RESOLVE_BLOCKER_FN) {
      const result = await this.blockers.resolve(blockerId, user);
      const messages = {
        resolved: '✅ Blocker resolved — everyone involved was notified.',
        already_resolved: 'This blocker was already resolved.',
        not_allowed: 'Only the reporter, tagged people, or a standup admin can resolve this blocker.',
        not_found: 'This blocker no longer exists.',
      };
      return { text: messages[result] };
    }

    return {};
  }

  private async onDialogSubmit(event: any, runId: number, user: Mention): Promise<object> {
    if (!Number.isInteger(runId)) return dialogError('This standup form is no longer valid.');
    const run = await this.repo.getRunById(runId);
    if (!run) return dialogError('This standup form is no longer valid.');
    const standup = (await this.repo.getStandupById(run.standupId))!;
    const questions = standupQuestions(standup);

    const answers: Answer[] = [];
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i]!;
      const value = getFormValue(event, `q${i}`).trim();
      if (!value && !isBlockerQuestion(question)) {
        return dialogError(`Please answer: "${question}"`);
      }
      answers.push({ question, answer: value || 'none' });
    }

    let mood: Mood | null = null;
    if (standup.moodEnabled) {
      const value = getFormValue(event, 'mood') as Mood;
      if (!MOODS.includes(value)) return dialogError('Please pick your mood from the dropdown.');
      mood = value;
    }

    const result = await this.service.submit(runId, user.userName, user.displayName, { answers, mood });

    if (result.ok) {
      if (result.edited) return dialogOk('✏️ Updated — your card in the team space was refreshed.');
      return dialogOk(
        result.late
          ? '✅ Submitted (after the deadline — marked late) and posted to the team space.'
          : '✅ Standup submitted — posted to the team space. Have a great day!',
      );
    }
    const messages: Record<typeof result.reason, string> = {
      already_submitted: 'This run is closed — late submissions can no longer be edited.',
      run_not_found: 'This standup form is no longer valid.',
      not_a_participant: "You're not on this standup's roster — ask your admin to `add` you.",
    };
    return dialogError(messages[result.reason]);
  }
}

function eventUser(event: any): Mention {
  return {
    userName: event.user?.name ?? '',
    displayName: event.user?.displayName ?? 'Unknown',
  };
}

function isDm(event: any): boolean {
  const type = event.space?.type ?? event.space?.spaceType;
  return type === 'DM' || type === 'DIRECT_MESSAGE';
}

function extractMentions(event: any): Mention[] {
  const annotations: any[] = event.message?.annotations ?? [];
  const mentions: Mention[] = [];
  const seen = new Set<string>();
  for (const a of annotations) {
    if (a?.type !== 'USER_MENTION') continue;
    const user = a.userMention?.user;
    if (!user?.name || user.type === 'BOT') continue;
    if (seen.has(user.name)) continue;
    seen.add(user.name);
    mentions.push({ userName: user.name, displayName: user.displayName ?? user.name });
  }
  return mentions;
}

/** Action parameters arrive as a map or a {key,value} list depending on event shape. */
function getParameter(event: any, key: string): string | undefined {
  const params = event.common?.parameters;
  if (params && typeof params === 'object' && !Array.isArray(params) && key in params) {
    return String(params[key]);
  }
  const list: any[] = Array.isArray(params) ? params : (event.action?.parameters ?? []);
  return list.find((p) => p?.key === key)?.value;
}

function getFormValue(event: any, name: string): string {
  return event.common?.formInputs?.[name]?.stringInputs?.value?.[0] ?? '';
}

function dialogOk(message: string): object {
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: { actionStatus: { statusCode: 'OK', userFacingMessage: message } },
    },
  };
}

/**
 * Failure reply in the shape the event expects: dialog events need a DIALOG
 * actionResponse — a plain text body silently drops the error in the modal.
 */
export function errorResponse(event: any): object {
  const message = '⚠️ Something went wrong handling that — please try again.';
  return event?.isDialogEvent ? dialogError(message) : { text: message };
}

function dialogError(message: string): object {
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: { actionStatus: { statusCode: 'INVALID_ARGUMENT', userFacingMessage: message } },
    },
  };
}
