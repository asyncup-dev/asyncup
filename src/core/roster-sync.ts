import { DateTime } from 'luxon';
import type { Repo } from '../db/repo.js';
import type { ChatAdapter } from './adapter.js';
import { GroupAccessError, type GroupDirectory } from './groups.js';
import type { StandupService } from './standup-service.js';
import type { Standup } from './types.js';

export type RosterSyncResult =
  | { ok: true; added: string[]; removed: string[]; skipped: { email: string; reason: string }[] }
  | { ok: false; message: string };

/**
 * Keeps a standup's roster in step with its Google Group, or with its Chat
 * space when people are picked by hand. With a group, joiners get the
 * default setup (on the standup, counted when missing, following the
 * standup's days); leavers drop off with their history kept. People taken
 * off by hand stay off, and people added by hand stay on. With the space,
 * only leaving counts: people seen in it come off when they leave and come
 * back if they rejoin.
 */
export class RosterSync {
  constructor(
    private repo: Repo,
    private groups: () => Promise<GroupDirectory | null>,
    private now: () => DateTime = () => DateTime.utc(),
    private log: (msg: string) => void = () => {},
    private standups: StandupService | null = null,
    private chat: Pick<ChatAdapter, 'spaceMembership'> | null = null,
  ) {}

  /** Whether the last sync is older than `minutes` (or never happened). */
  stale(standup: Standup, minutes: number): boolean {
    if (!standup.rosterGroup && !this.chat) return false;
    return !standup.rosterSyncedAt || this.now().diff(DateTime.fromISO(standup.rosterSyncedAt), 'minutes').minutes >= minutes;
  }

  async sync(standup: Standup): Promise<RosterSyncResult> {
    const at = this.now().toUTC().toISO()!;
    const fail = async (message: string): Promise<RosterSyncResult> => {
      await this.repo.setRosterSync(standup.id, at, message);
      this.log(`roster sync for "${standup.name}" failed: ${message}`);
      return { ok: false, message };
    };
    if (!standup.rosterGroup) return this.syncSpace(standup, at, fail);
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
        await this.standups?.leaveOpenRuns(standup, row.userName);
        removed.push(row.displayName);
      }
    }
    await this.repo.setRosterSync(standup.id, at, null);
    return { ok: true, added, removed, skipped: listing.skipped };
  }

  private async syncSpace(standup: Standup, at: string, fail: (message: string) => Promise<RosterSyncResult>): Promise<RosterSyncResult> {
    if (!this.chat) return { ok: false, message: 'Google Chat is not connected, so the space can’t be checked.' };
    let membership;
    try {
      membership = await this.chat.spaceMembership(standup.spaceName);
    } catch (err) {
      return fail(`Google Chat did not answer, so nobody was taken off: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (membership.people.length === 0 && membership.groups.length === 0) return fail('The space listed no members, so nobody was taken off.');

    const present = new Set(membership.people.map((p) => p.userName));
    // A group that can't be read hides who is in the space, so nobody may come off.
    let unreadable: string | null = null;
    const directory = membership.groups.length ? await this.groups() : null;
    for (const group of membership.groups) {
      if (!directory) {
        unreadable = `A Google Group in this space (${group}) can’t be read without the service-account key under Settings › Google Chat, so nobody was taken off.`;
        break;
      }
      try {
        for (const m of (await directory.listMembers(group.replace(/^groups\//, ''))).members) present.add(m.userName);
      } catch (err) {
        const why = err instanceof GroupAccessError ? err.message : `Google did not answer: ${err instanceof Error ? err.message : String(err)}`;
        unreadable = `A Google Group in this space can’t be read (${group}), so nobody was taken off. ${why}`;
        break;
      }
    }

    const added: string[] = [];
    const removed: string[] = [];
    for (const row of await this.repo.listRosterRows(standup.id)) {
      const here = present.has(row.userName);
      if (row.active && here) await this.repo.markInSpace(standup.id, row.userName);
      else if (!row.active && here && row.leftSpaceAt) {
        await this.repo.rejoinSpace(standup.id, row.userName);
        added.push(row.displayName);
      } else if (row.active && !here && row.inSpace && !unreadable) {
        await this.repo.leaveSpace(standup.id, row.userName, at);
        await this.standups?.leaveOpenRuns(standup, row.userName);
        removed.push(row.displayName);
      }
    }
    if (unreadable) return fail(unreadable);
    await this.repo.setRosterSync(standup.id, at, null);
    return { ok: true, added, removed, skipped: [] };
  }
}
