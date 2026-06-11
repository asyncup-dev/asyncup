import { DateTime } from 'luxon';
import type { ChatAdapter } from './adapter.js';
import type { Repo } from '../db/repo.js';
import {
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
  | { ok: false; reason: 'already_submitted' | 'run_not_found' | 'not_a_participant' };

export type SkipResult = 'skipped' | 'already_submitted' | 'not_found';

export class StandupService {
  constructor(
    private repo: Repo,
    private adapter: ChatAdapter,
    private now: () => DateTime = () => DateTime.utc(),
  ) {}

  /**
   * Records a dialog submission and posts it under the day's thread.
   * Re-submitting while the run is open edits the existing card in place;
   * submissions after the deadline still post, flagged as late.
   */
  async submit(
    runId: number,
    userName: string,
    displayName: string,
    input: SubmissionInput,
  ): Promise<SubmitResult> {
    const run = this.repo.getRunById(runId);
    if (!run) return { ok: false, reason: 'run_not_found' };

    const isParticipant = this.repo.listRunParticipants(run.id).some((p) => p.userName === userName);
    if (!isParticipant) return { ok: false, reason: 'not_a_participant' };

    const standup = this.repo.getStandupById(run.standupId)!;
    const existing = this.repo.getSubmission(run.id, userName);

    if (existing) {
      if (run.status === 'closed') return { ok: false, reason: 'already_submitted' };
      const updated = this.repo.updateSubmission(existing.id, input.answers, input.mood, this.now().toISO()!);
      this.repo.deleteBlockersOpenedBy(run.id, userName);
      this.trackBlockers(standup, run, userName, displayName, input, { resolveOthers: false });
      if (updated.messageName) await this.adapter.updateSubmission(standup, updated);
      return { ok: true, late: false, edited: true };
    }

    const late = run.status === 'closed';
    const submission = this.repo.createSubmission({
      runId: run.id,
      userName,
      displayName,
      answers: input.answers,
      mood: input.mood,
      late,
      submittedAt: this.now().toISO()!,
    });
    this.trackBlockers(standup, run, userName, displayName, input, { resolveOthers: true });

    const messageName = await this.adapter.postSubmission(standup, run, submission);
    if (messageName) this.repo.setSubmissionMessageName(submission.id, messageName);
    return { ok: true, late, edited: false };
  }

  private trackBlockers(
    standup: Standup,
    run: Run,
    userName: string,
    displayName: string,
    input: SubmissionInput,
    opts: { resolveOthers: boolean },
  ): void {
    const texts = blockerAnswers(input);
    for (const text of texts) {
      this.repo.openBlocker({ standupId: standup.id, userName, displayName, text, runId: run.id, date: run.date });
    }
    // A blocker-free submission resolves the person's previously open blockers.
    if (texts.length === 0 && opts.resolveOthers) {
      this.repo.resolveBlockersFor(standup.id, userName, run.id, run.date);
    }
  }

  /** Mark a participant as sitting out today's run (no effect once submitted). */
  skipToday(runId: number, userName: string): SkipResult {
    const run = this.repo.getRunById(runId);
    if (!run) return 'not_found';
    if (this.repo.getSubmission(run.id, userName)) return 'already_submitted';
    return this.repo.markSkipped(run.id, userName, this.now().toISO()!) ? 'skipped' : 'not_found';
  }

  /**
   * Prefill values aligned with the standup's questions: "yesterday"-style
   * questions get the user's previous answer to the "today"-style question.
   */
  getPrefill(standup: Standup, run: Run, userName: string): string[] {
    const questions = standupQuestions(standup);
    const existing = this.repo.getSubmission(run.id, userName);
    if (existing) {
      // Editing: prefill with what they already submitted.
      return questions.map((q) => existing.answers.find((a) => a.question === q)?.answer ?? '');
    }
    const previous = this.repo.getPreviousSubmission(standup.id, userName, run.id);
    if (!previous) return questions.map(() => '');
    const prevToday = previous.answers.find((a) => isTodayQuestion(a.question))?.answer ?? '';
    return questions.map((q) => (isYesterdayQuestion(q) ? prevToday : ''));
  }

  buildSummary(runId: number): RunSummary {
    const run = this.repo.getRunById(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const standup = this.repo.getStandupById(run.standupId)!;
    const participants = this.repo.listRunParticipants(run.id);
    const submissions = this.repo.listSubmissions(run.id);
    const submittedBy = new Set(submissions.map((s) => s.userName));

    const mandatory = participants.filter((p) => p.mandatory);
    const away: string[] = [];
    const missing: string[] = [];
    let submitted = 0;
    for (const p of mandatory) {
      if (submittedBy.has(p.userName)) submitted++;
      else if (p.skippedAt || p.onVacation) away.push(p.displayName);
      else missing.push(p.displayName);
    }

    return {
      standupName: standup.name,
      date: run.date,
      mandatoryTotal: submitted + missing.length,
      mandatorySubmitted: submitted,
      missingMandatory: missing,
      away,
      optionalSubmitted: submissions.filter(
        (s) => !mandatory.some((p) => p.userName === s.userName),
      ).length,
      lateCount: submissions.filter((s) => s.late).length,
      openBlockers: this.repo.listOpenBlockers(standup.id).length,
    };
  }
}
