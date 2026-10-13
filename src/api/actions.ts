import type { DateTime } from 'luxon';
import type { ChatAdapter } from '../core/adapter.js';
import { memberStandups, setMemberTimezone, setMemberVacation } from '../core/member.js';
import { runProgress } from '../core/progress.js';
import type { StandupService } from '../core/standup-service.js';
import type { Standup } from '../core/types.js';
import type { Repo } from '../db/repo.js';
import { person } from './views.js';

/**
 * Write operations shared by the JSON API and the MCP tools, so both
 * surfaces apply the same rules and report the same outcomes.
 */

export type Refusal = { ok: false; status: number; code: string; message: string; field?: string };

/** Reminds everyone still expected today. Leaves remindedAt alone, so the scheduled reminder still fires. */
export async function nudgeToday(repo: Repo, adapter: ChatAdapter, standup: Standup, now: DateTime): Promise<{ ok: true; nudged: { userName: string; displayName: string }[] } | Refusal> {
  const run = await repo.getRun(standup.id, now.setZone(standup.timezone).toISODate()!);
  if (!run || run.status !== 'open') return { ok: false, status: 409, code: 'no_open_run', message: 'There is no open run today — use run-now first.' };
  const progress = runProgress(await repo.listRunParticipants(run.id), await repo.listSubmissions(run.id));
  for (const rp of progress.pending) {
    const card = await adapter.sendReminder(rp.userName, standup, run);
    if (card) await repo.addCardMessage(run.id, rp.userName, card);
  }
  return { ok: true, nudged: progress.pending.map(person) };
}

/** Skips today's run of one standup for a person — the twin of the DM `skip` command. */
export async function skipToday(repo: Repo, service: StandupService, standup: Standup, userName: string, now: DateTime): Promise<{ ok: true; result: 'skipped'; date: string } | Refusal> {
  const run = await repo.getRun(standup.id, now.setZone(standup.timezone).toISODate()!);
  if (!run || run.status !== 'open') {
    return { ok: false, status: 409, code: 'no_open_run', message: run ? 'Today’s run has already closed.' : 'Today’s run has not opened yet.' };
  }
  const result = await service.skipToday(run.id, userName);
  if (result === 'already_submitted') return { ok: false, status: 409, code: 'already_submitted', message: 'You already answered today — edit your answers in Chat instead.' };
  if (result === 'not_found') return { ok: false, status: 404, code: 'not_found', message: 'You are not on today’s run.' };
  return { ok: true, result, date: run.date };
}

/** A person's own timezone and vacation; a null or empty timezone follows the standups again. */
export async function updateMe(
  repo: Repo,
  userName: string,
  change: { timezone?: string | null; onVacation?: boolean },
  now: DateTime,
): Promise<{ ok: true; timezone: string | null; onVacation: boolean } | Refusal> {
  if (change.timezone !== undefined) {
    const result = await setMemberTimezone(repo, userName, change.timezone ?? '');
    if (!result.ok) return { ok: false, status: 400, code: 'invalid', message: result.message, field: 'timezone' };
  }
  if (change.onVacation !== undefined) await setMemberVacation(repo, userName, change.onVacation);
  const mine = await memberStandups(repo, userName, now);
  return { ok: true, timezone: await repo.getUserTimezone(userName), onVacation: mine.length > 0 && mine.every((m) => m.onVacation) };
}
