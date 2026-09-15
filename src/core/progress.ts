import type { RunParticipant, Submission } from './types.js';

/**
 * The one definition of "who is done / away / still expected" for a run.
 * Wrap-up reports additionally restrict to mandatory participants — that is
 * buildSummary's job; every "X/Y submitted" progress view uses this.
 */
export interface RunProgress {
  done: RunParticipant[];
  pending: RunParticipant[];
  away: RunParticipant[];
  /** Mandatory participants who are neither done nor away — the wrap-up's "missing". */
  missingMandatory: RunParticipant[];
  /** done.length / expected — expected excludes away people. */
  submitted: number;
  expected: number;
}

export function runProgress(roster: RunParticipant[], submissions: Submission[]): RunProgress {
  const submittedBy = new Set(submissions.map((s) => s.userName));
  const done = roster.filter((p) => submittedBy.has(p.userName));
  const away = roster.filter((p) => !submittedBy.has(p.userName) && (p.skippedAt || p.onVacation));
  const pending = roster.filter((p) => !submittedBy.has(p.userName) && !p.skippedAt && !p.onVacation);
  return {
    done,
    pending,
    away,
    missingMandatory: pending.filter((p) => p.mandatory),
    submitted: done.length,
    expected: roster.length - away.length,
  };
}
