import type { DateTime } from 'luxon';
import type { Repo } from '../db/repo.js';
import type { Standup } from './types.js';
import { isValidZone } from './validation.js';

/**
 * What a signed-in person can do about their own standups — shared by the
 * /me console and the JSON API so the rules cannot drift.
 */
export type MemberTodayStatus = 'submitted' | 'waiting' | 'closed' | null;

export interface MemberStandup {
  standup: Standup;
  /** null when today's run has not opened. */
  today: MemberTodayStatus;
  mandatory: boolean;
  onVacation: boolean;
}

export async function memberStandups(repo: Repo, userName: string, now: DateTime): Promise<MemberStandup[]> {
  const out: MemberStandup[] = [];
  for (const standup of await repo.listStandupsForUser(userName)) {
    const me = (await repo.listParticipants(standup.id)).find((p) => p.userName === userName);
    const run = await repo.getRun(standup.id, now.setZone(standup.timezone).toISODate()!);
    let today: MemberTodayStatus = null;
    if (run) {
      const mine = await repo.getSubmission(run.id, userName);
      today = mine ? 'submitted' : run.status === 'open' ? 'waiting' : 'closed';
    }
    out.push({ standup, today, mandatory: me?.mandatory ?? true, onVacation: me?.onVacation ?? false });
  }
  return out;
}

export type TimezoneResult = { ok: true; timezone: string | null } | { ok: false; message: string };

/** Empty clears the override so prompts follow each standup's zone. */
export async function setMemberTimezone(repo: Repo, userName: string, raw: string): Promise<TimezoneResult> {
  const tz = raw.trim();
  if (tz && !isValidZone(tz)) return { ok: false, message: `Invalid IANA timezone: ${tz}` };
  await repo.setTimezoneForUser(userName, tz || null);
  return { ok: true, timezone: tz || null };
}

export async function setMemberVacation(repo: Repo, userName: string, on: boolean): Promise<void> {
  await repo.setVacationForUser(userName, on);
}
