import type { DateTime } from 'luxon';
import { runProgress } from '../core/progress.js';
import { MOOD_SCORE, type Blocker, type Standup, type Submission } from '../core/types.js';
import type { Repo } from '../db/repo.js';
import type { Principal } from './principal.js';
import { findVisibleStandup, visibleStandups } from './shared.js';

/**
 * Read models shared by the JSON API and the MCP tools, so both surfaces
 * show the same shapes and apply the same visibility rules.
 */

export function person(p: { userName: string; displayName: string }) {
  return { userName: p.userName, displayName: p.displayName };
}

/** Team mood for a run, rounded to one decimal; null when nobody picked one. */
export function averageMood(submissions: Submission[]): number | null {
  const scores = submissions.flatMap((s) => (s.mood ? [MOOD_SCORE[s.mood]] : []));
  return scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
}

/** A submission as the API shows it — mood withheld when the standup keeps moods anonymous. */
export function submissionView(standup: Standup, s: Submission) {
  return {
    userName: s.userName,
    displayName: s.displayName,
    submittedAt: s.submittedAt,
    editedAt: s.editedAt,
    late: s.late,
    mood: standup.moodAnonymous ? null : s.mood,
    answers: s.answers,
  };
}

export async function blockerView(repo: Repo, b: Blocker, standupName: string) {
  const tags = await repo.listBlockerTags(b.id);
  const updates = await repo.listBlockerUpdates(b.id);
  return {
    id: b.id,
    standup: { id: b.standupId, name: standupName },
    owner: { userName: b.userName, displayName: b.displayName },
    text: b.text,
    openedDate: b.openedDate,
    resolvedDate: b.resolvedDate,
    resolvedBy: b.resolvedBy,
    escalatedAt: b.escalatedAt,
    status: b.resolvedDate ? 'resolved' : tags.some((t) => t.acknowledgedAt) ? 'acknowledged' : 'open',
    tags: tags.map((t) => ({ userName: t.userName, displayName: t.displayName, acknowledgedAt: t.acknowledgedAt })),
    updates: updates.map((u) => ({ userName: u.userName, displayName: u.displayName, text: u.text, at: u.createdAt })),
  };
}

export const BLOCKER_STATUSES = ['open', 'acknowledged', 'resolved', 'all'] as const;
export type BlockerStatusFilter = (typeof BLOCKER_STATUSES)[number];

/** Blockers across every standup the caller can see. */
export async function blockersView(
  repo: Repo,
  p: Principal,
  opts: { status: BlockerStatusFilter; standupId: number | null; owner?: string },
) {
  const visible = await visibleStandups(repo, p);
  const standupIds = visible.map((s) => s.id).filter((id) => opts.standupId === null || id === opts.standupId);
  const names = new Map(visible.map((s) => [s.id, s.name]));
  const rows = await repo.listBlockers({
    tenantId: p.tenantId,
    status: opts.status === 'acknowledged' ? 'open' : opts.status,
    standupIds,
    ...(opts.owner ? { userName: opts.owner } : {}),
  });
  const blockers = [];
  for (const b of rows) {
    const v = await blockerView(repo, b, names.get(b.standupId)!);
    if (opts.status === 'acknowledged' && v.status !== 'acknowledged') continue;
    blockers.push(v);
  }
  return blockers;
}

/** A blocker on a standup the caller can see. */
export async function visibleBlocker(repo: Repo, p: Principal, blockerId: number): Promise<Blocker | null> {
  const blocker = await repo.getBlockerById(blockerId);
  return blocker && (await findVisibleStandup(repo, p, blocker.standupId)) ? blocker : null;
}

export async function runsView(repo: Repo, standup: Standup, limit: number) {
  const runs = [];
  for (const run of await repo.listRecentRuns(standup.id, limit)) {
    const progress = runProgress(await repo.listRunParticipants(run.id), await repo.listSubmissions(run.id));
    runs.push({
      date: run.date,
      status: run.status,
      submitted: progress.submitted,
      expected: progress.expected,
      missing: progress.missingMandatory.map(person),
    });
  }
  return runs;
}

/** Today, shaped for polling: who is done, who is still expected, who is away. */
export async function todayView(repo: Repo, standup: Standup, now: DateTime) {
  const date = now.setZone(standup.timezone).toISODate()!;
  const run = await repo.getRun(standup.id, date);
  if (!run) return { date, status: null, expected: 0, submitted: [], waiting: [], away: [], teamMood: null };
  const submissions = await repo.listSubmissions(run.id);
  const progress = runProgress(await repo.listRunParticipants(run.id), submissions);
  const byUser = new Map(submissions.map((s) => [s.userName, s]));
  return {
    date,
    status: run.status,
    expected: progress.expected,
    submitted: progress.done.map((rp) => {
      const s = byUser.get(rp.userName)!;
      return { ...person(rp), submittedAt: s.submittedAt, late: s.late, mood: standup.moodAnonymous ? null : s.mood };
    }),
    waiting: progress.pending.map((rp) => ({ ...person(rp), mandatory: rp.mandatory, remindedAt: rp.remindedAt })),
    away: progress.away.map((rp) => ({ ...person(rp), reason: rp.skippedAt ? 'skipped' : 'vacation' })),
    teamMood: standup.moodAnonymous ? averageMood(submissions) : null,
  };
}

/** One run with full submissions, or null when there was none that day. */
export async function runView(repo: Repo, standup: Standup, date: string) {
  const run = await repo.getRun(standup.id, date);
  if (!run) return null;
  const submissions = await repo.listSubmissions(run.id);
  const progress = runProgress(await repo.listRunParticipants(run.id), submissions);
  return {
    date,
    status: run.status,
    submitted: progress.submitted,
    expected: progress.expected,
    missing: progress.missingMandatory.map(person),
    submissions: submissions.map((s) => submissionView(standup, s)),
    teamMood: standup.moodAnonymous ? averageMood(submissions) : null,
  };
}

/** Everyone on a roster the caller can see, with their standups. */
export async function peopleView(repo: Repo, p: Principal) {
  const visible = new Set((await visibleStandups(repo, p)).map((s) => s.id));
  const emails = new Map((await repo.listUserEmails()).map((e) => [e.userName, e.email]));
  const admins = new Set<string>();
  for (const id of visible) for (const a of await repo.listAdmins(id)) admins.add(`${id}:${a.userName}`);

  const people = new Map<
    string,
    {
      userName: string;
      displayName: string;
      email: string | null;
      timezone: string | null;
      onVacation: boolean;
      standups: { id: number; name: string; mandatory: boolean; admin: boolean }[];
    }
  >();
  for (const row of await repo.listTenantParticipants(p.tenantId)) {
    if (!visible.has(row.standupId)) continue;
    const entry = people.get(row.userName) ?? {
      userName: row.userName,
      displayName: row.displayName,
      email: emails.get(row.userName) ?? null,
      timezone: row.timezone,
      onVacation: false,
      standups: [],
    };
    entry.onVacation = entry.onVacation || row.onVacation;
    entry.standups.push({
      id: row.standupId,
      name: row.standupName,
      mandatory: row.mandatory,
      admin: admins.has(`${row.standupId}:${row.userName}`),
    });
    people.set(row.userName, entry);
  }
  return [...people.values()];
}

