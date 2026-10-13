import { DateTime } from 'luxon';
import type { Repo } from '../db/repo.js';
import { GroupAccessError, type GroupDirectory } from './groups.js';
import type { Standup } from './types.js';

export type RosterSyncResult =
  | { ok: true; added: string[]; removed: string[]; skipped: { email: string; reason: string }[] }
  | { ok: false; message: string };

/**
 * Keeps a standup's roster in step with its Google Group. Joiners get the
 * default setup (on the standup, counted when missing, following the
 * standup's days); leavers drop off with their history kept. People taken
 * off by hand stay off, and people added by hand stay on.
 */
export class RosterSync {
  constructor(
    private repo: Repo,
    private groups: () => Promise<GroupDirectory | null>,
    private now: () => DateTime = () => DateTime.utc(),
    private log: (msg: string) => void = () => {},
  ) {}

  /** Whether the last sync is older than `minutes` (or never happened). */
  stale(standup: Standup, minutes: number): boolean {
    if (!standup.rosterGroup) return false;
    return !standup.rosterSyncedAt || this.now().diff(DateTime.fromISO(standup.rosterSyncedAt), 'minutes').minutes >= minutes;
  }

  async sync(standup: Standup): Promise<RosterSyncResult> {
    if (!standup.rosterGroup) return { ok: false, message: 'This standup’s people are added by hand; set a roster group first.' };
    const at = this.now().toUTC().toISO()!;
    const fail = async (message: string): Promise<RosterSyncResult> => {
      await this.repo.setRosterSync(standup.id, at, message);
      this.log(`roster sync for "${standup.name}" failed: ${message}`);
      return { ok: false, message };
    };
    const directory = await this.groups();
    if (!directory) return fail('Reading Google Groups needs the service-account key under Settings › Google Chat.');
    let listing;
    try {
      listing = await directory.listMembers(standup.rosterGroup);
    } catch (err) {
      return fail(err instanceof GroupAccessError ? err.message : `Google did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }

    const rows = new Map((await this.repo.listRosterRows(standup.id)).map((r) => [r.userName, r]));
    const inGroup = new Set(listing.members.map((m) => m.userName));
    const added: string[] = [];
    const removed: string[] = [];
    for (const m of listing.members) {
      const row = rows.get(m.userName);
      if (!row || (!row.active && !row.keptOff)) added.push(m.displayName);
      await this.repo.syncGroupMember(standup.id, m.userName, m.displayName);
    }
    for (const row of rows.values()) {
      if (row.source === 'group' && row.active && !inGroup.has(row.userName)) {
        await this.repo.dropGroupMember(standup.id, row.userName);
        removed.push(row.displayName);
      }
    }
    await this.repo.setRosterSync(standup.id, at, null);
    return { ok: true, added, removed, skipped: listing.skipped };
  }
}
