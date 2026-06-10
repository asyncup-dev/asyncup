import { DateTime } from 'luxon';
import type { ChatAdapter } from './adapter.js';
import type { Repo } from '../db/repo.js';
import type { RunSummary, SubmissionAnswers } from './types.js';

export type SubmitResult =
  | { ok: true; late: boolean }
  | { ok: false; reason: 'already_submitted' | 'run_not_found' | 'not_a_participant' };

export class StandupService {
  constructor(
    private repo: Repo,
    private adapter: ChatAdapter,
    private now: () => DateTime = () => DateTime.utc(),
  ) {}

  /**
   * Records a dialog submission and posts it under the day's thread.
   * Submissions after the deadline still post, flagged as late.
   */
  async submit(
    runId: number,
    userName: string,
    displayName: string,
    answers: SubmissionAnswers,
  ): Promise<SubmitResult> {
    const run = this.repo.getRunById(runId);
    if (!run) return { ok: false, reason: 'run_not_found' };

    const isParticipant = this.repo.listRunParticipants(run.id).some((p) => p.userName === userName);
    if (!isParticipant) return { ok: false, reason: 'not_a_participant' };

    if (this.repo.getSubmission(run.id, userName)) {
      return { ok: false, reason: 'already_submitted' };
    }

    const late = run.status === 'closed';
    const submission = this.repo.createSubmission({
      runId: run.id,
      userName,
      displayName,
      answers,
      late,
      submittedAt: this.now().toISO()!,
    });

    const standup = this.repo.getStandupById(run.standupId)!;
    await this.adapter.postSubmission(standup, run, submission);
    return { ok: true, late };
  }

  buildSummary(runId: number): RunSummary {
    const run = this.repo.getRunById(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const standup = this.repo.getStandupById(run.standupId)!;
    const participants = this.repo.listRunParticipants(run.id);
    const submissions = this.repo.listSubmissions(run.id);
    const submittedBy = new Set(submissions.map((s) => s.userName));

    const mandatory = participants.filter((p) => p.mandatory);
    const missingMandatory = mandatory.filter((p) => !submittedBy.has(p.userName)).map((p) => p.displayName);

    return {
      standupName: standup.name,
      date: run.date,
      mandatoryTotal: mandatory.length,
      mandatorySubmitted: mandatory.length - missingMandatory.length,
      missingMandatory,
      optionalSubmitted: submissions.filter(
        (s) => !mandatory.some((p) => p.userName === s.userName),
      ).length,
      lateCount: submissions.filter((s) => s.late).length,
    };
  }
}
