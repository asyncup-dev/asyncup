import { DateTime } from 'luxon';
import type { ChatAdapter, PromptState } from './adapter.js';
import type { WebhookNotifier } from './webhooks.js';
import type { Repo } from '../db/repo.js';
import { EditRequests } from './edit-requests.js';
import { runProgress } from './progress.js';
import { roundMood } from './insights.js';
import {
  MOOD_SCORE,
  blockerAnswers,
  isTodayQuestion,
  isYesterdayQuestion,
  standupQuestions,
  type Run,
  type RunSummary,
  type Standup,
  type SubmissionInput,
} from './types.js';

export type SubmitResult =
  | { ok: true; late: boolean; edited: boolean }
  | { ok: false; reason: 'already_submitted' | 'day_closed' | 'run_not_found' | 'not_a_participant' };

export type SkipResult = 'skipped' | 'already_submitted' | 'not_found';
export type UnskipResult = 'unskipped' | 'not_skipped' | 'closed' | 'not_found';

export class StandupService {
  constructor(
    private repo: Repo,
    private adapter: ChatAdapter,
    private now: () => DateTime = () => DateTime.utc(),
    private webhooks: WebhookNotifier | null = null,
    private log: (msg: string) => void = () => {},
  ) {
    this.edits = new EditRequests(repo, adapter, this, now, (msg) => this.log(msg));
  }

  /** Asking to edit answers after the deadline. */
  readonly edits: EditRequests;

  /**
   * Records a dialog submission and posts it under the day's thread.
   * Re-submitting while the run is open edits the existing card in place;
   * after the deadline that needs a manager's approval. A first answer after
   * the deadline still posts, flagged as late. Both stop at midnight.
   */
  async submit(
    runId: number,
    userName: string,
    displayName: string,
    input: SubmissionInput,
  ): Promise<SubmitResult> {
    const run = await this.repo.getRunById(runId);
    if (!run) return { ok: false, reason: 'run_not_found' };

    const roster = await this.repo.listRunParticipants(run.id);
    if (!roster.some((p) => p.userName === userName)) {
      return { ok: false, reason: 'not_a_participant' };
    }

    const standup = (await this.repo.getStandupById(run.standupId))!;
    const existing = await this.repo.getSubmission(run.id, userName);
    if (run.status === 'closed' && this.edits.dayOver(standup, run)) return { ok: false, reason: 'day_closed' };

    if (existing) {
      let approvedBy = existing.editApprovedBy;
      if (run.status === 'closed') {
        const request = await this.repo.getEditRequestFor(run.id, userName);
        if (request?.status !== 'approved') return { ok: false, reason: 'already_submitted' };
        approvedBy = request.decidedBy;
      }
      const updated = await this.repo.updateSubmission(
        existing.id,
        input.answers,
        input.mood,
        input.moodComment ?? null,
        this.now().toISO()!,
        approvedBy,
      );
      await this.repo.deleteBlockersOpenedBy(run.id, userName);
      await this.trackBlockers(standup, run, userName, displayName, input, { resolveOthers: false });
      if (updated.messageName) await this.adapter.updateSubmission(standup, updated);
      await this.webhooks?.submission(standup, run.date, updated, true);
      await this.refreshCards(standup, run, userName);
      return { ok: true, late: false, edited: true };
    }

    const late = run.status === 'closed';
    const submission = await this.repo.createSubmission({
      runId: run.id,
      userName,
      displayName,
      answers: input.answers,
      mood: input.mood,
      moodComment: input.moodComment ?? null,
      late,
      submittedAt: this.now().toISO()!,
    });
    await this.trackBlockers(standup, run, userName, displayName, input, { resolveOthers: true });

    const messageName = await this.adapter.postSubmission(standup, run, submission);
    if (messageName) await this.repo.setSubmissionMessageName(submission.id, messageName);
    await this.webhooks?.submission(standup, run.date, submission, false);
    await this.refreshCards(standup, run, userName);
    return { ok: true, late, edited: false };
  }

  /** Rewrites the prompt, reminder and nudge cards a person was sent, to show they submitted, skipped or are still due. */
  async refreshCards(standup: Standup, run: Run, userName: string): Promise<void> {
    const names = await this.repo.listCardMessages(run.id, userName);
    if (names.length === 0) return;
    const submission = await this.repo.getSubmission(run.id, userName);
    const rp = (await this.repo.listRunParticipants(run.id)).find((p) => p.userName === userName);
    const closed = (await this.repo.getRunById(run.id))?.status === 'closed';
    const state: PromptState = submission
      ? { kind: 'submitted', at: submission.submittedAt, late: submission.late, ...(closed ? { closed, edit: await this.edits.stateFor(standup, run, userName) } : {}) }
      : rp?.skippedAt
        ? { kind: 'skipped', note: rp.skipNote }
        : { kind: 'open' };
    try {
      await this.adapter.updateStandupCards(names, standup, run, state);
    } catch (err) {
      this.log(`updating ${userName}'s cards for run ${run.id} failed: ${err}`);
    }
  }

  /** At the deadline, everyone who answered sees how to ask for an edit. */
  async refreshClosedCards(standup: Standup, run: Run): Promise<void> {
    for (const submission of await this.repo.listSubmissions(run.id)) await this.refreshCards(standup, run, submission.userName);
  }

  private async trackBlockers(
    standup: Standup,
    run: Run,
    userName: string,
    displayName: string,
    input: SubmissionInput,
    opts: { resolveOthers: boolean },
  ): Promise<void> {
    // Collaborative blockers survive an edit; don't reopen them as duplicates.
    const surviving = new Set(
      (await this.repo.listBlockersOpenedBy(run.id, userName)).map((b) => b.text),
    );
    const texts = blockerAnswers(input).filter((t) => !surviving.has(t));
    for (const text of texts) {
      await this.repo.openBlocker({
        standupId: standup.id,
        userName,
        displayName,
        text,
        runId: run.id,
        date: run.date,
      });
    }
    // The owner gets a card for each new blocker, the one place to pull people in from.
    for (const blocker of (await this.repo.listBlockersOpenedBy(run.id, userName)).filter((b) => texts.includes(b.text))) {
      try {
        await this.adapter.sendBlockerCard(userName, standup, blocker, 'From your standup today. Tag people who can help, add updates, or resolve it.', true);
      } catch (err) {
        this.log(`blocker card to ${userName} failed: ${err}`);
      }
    }
    // A blocker-free submission resolves the person's previously open blockers.
    if (texts.length === 0 && opts.resolveOthers) {
      await this.repo.resolveBlockersFor(standup.id, userName, run.id, run.date);
    }
  }

  /** Mark a participant as sitting out today's run and tell the thread why (no effect once submitted). */
  async skipToday(runId: number, userName: string, note: string): Promise<SkipResult> {
    const run = await this.repo.getRunById(runId);
    if (!run) return 'not_found';
    if (await this.repo.getSubmission(run.id, userName)) return 'already_submitted';
    const before = (await this.repo.listRunParticipants(run.id)).find((p) => p.userName === userName);
    if (!before) return 'not_found';
    await this.repo.markSkipped(run.id, userName, this.now().toISO()!, note);
    const standup = (await this.repo.getStandupById(run.standupId))!;
    // A second skip replaces the first reason rather than stacking replies.
    if (before.skipMessage) await this.removeMessage(before.skipMessage);
    try {
      await this.repo.setSkipMessage(run.id, userName, await this.adapter.postSkip(standup, run, before.displayName, note));
    } catch (err) {
      this.log(`posting ${userName}'s skip for run ${run.id} failed: ${err}`);
    }
    await this.refreshCards(standup, run, userName);
    return 'skipped';
  }

  /** Someone taken off the standup leaves its open run too, unless they already answered. */
  async leaveOpenRuns(standup: Standup, userName: string): Promise<void> {
    for (const run of await this.repo.listOpenRuns(standup.id)) {
      if (await this.repo.getSubmission(run.id, userName)) continue;
      const names = await this.repo.listCardMessages(run.id, userName);
      await this.repo.removeRunParticipant(run.id, userName);
      if (names.length === 0) continue;
      try {
        await this.adapter.updateStandupCards(names, standup, run, { kind: 'removed' });
      } catch (err) {
        this.log(`updating ${userName}'s cards for run ${run.id} failed: ${err}`);
      }
    }
  }

  private async removeMessage(messageName: string): Promise<void> {
    try {
      await this.adapter.deleteMessage(messageName);
    } catch (err) {
      this.log(`deleting ${messageName} failed: ${err}`);
    }
  }

  /** Today's date in the standup's timezone. */
  today(standup: Standup): string {
    return this.now().setZone(standup.timezone).toISODate()!;
  }

  /** Takes back a skip while the run is open: the person is expected again. */
  async unskip(runId: number, userName: string): Promise<UnskipResult> {
    const run = await this.repo.getRunById(runId);
    if (!run) return 'not_found';
    if (run.status !== 'open') return 'closed';
    const skipMessage = (await this.repo.listRunParticipants(run.id)).find((p) => p.userName === userName)?.skipMessage;
    if (!(await this.repo.clearSkipped(run.id, userName))) return 'not_skipped';
    if (skipMessage) await this.removeMessage(skipMessage);
    await this.refreshCards((await this.repo.getStandupById(run.standupId))!, run, userName);
    return 'unskipped';
  }

  /**
   * Prefill values aligned with the standup's questions: "yesterday"-style
   * questions get the user's previous answer to the "today"-style question.
   */
  async getPrefill(standup: Standup, run: Run, userName: string): Promise<string[]> {
    const questions = standupQuestions(standup);
    const existing = await this.repo.getSubmission(run.id, userName);
    if (existing) {
      // Editing: prefill with what they already submitted.
      return questions.map((q) => existing.answers.find((a) => a.question === q)?.answer ?? '');
    }
    const previous = await this.repo.getPreviousSubmission(standup.id, userName, run.id);
    if (!previous) return questions.map(() => '');
    const prevToday = previous.answers.find((a) => isTodayQuestion(a.question))?.answer ?? '';
    return questions.map((q) => (isYesterdayQuestion(q) ? prevToday : ''));
  }

  async buildSummary(runId: number): Promise<RunSummary> {
    const run = await this.repo.getRunById(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const standup = (await this.repo.getStandupById(run.standupId))!;
    const participants = await this.repo.listRunParticipants(run.id);
    const submissions = await this.repo.listSubmissions(run.id);
    const progress = runProgress(participants, submissions);

    // The wrap-up counts mandatory people only (that is its contract).
    const mandatory = participants.filter((p) => p.mandatory);
    const submitted = progress.done.filter((p) => p.mandatory).length;
    const missing = progress.missingMandatory.map((p) => p.displayName);

    // Kept for the wrap_up webhook; the posted wrap-up never shows mood.
    const moods = standup.moodAnonymous ? submissions.flatMap((s) => (s.mood ? [MOOD_SCORE[s.mood]] : [])) : [];
    const teamMood = moods.length ? roundMood(moods.reduce((a, b) => a + b, 0) / moods.length) : null;

    return {
      standupName: standup.name,
      date: run.date,
      mandatoryTotal: submitted + missing.length,
      mandatorySubmitted: submitted,
      missingMandatory: missing,
      away: progress.away.filter((p) => p.mandatory).map((p) => p.displayName),
      optionalSubmitted: submissions.filter(
        (s) => !mandatory.some((p) => p.userName === s.userName),
      ).length,
      lateCount: submissions.filter((s) => s.late).length,
      openBlockers: (await this.repo.listOpenBlockers(standup.id)).length,
      teamMood,
    };
  }
}
