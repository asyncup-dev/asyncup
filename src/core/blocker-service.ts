import { DateTime } from 'luxon';
import type { ChatAdapter } from './adapter.js';
import type { Mention } from './commands.js';
import type { Repo } from '../db/repo.js';
import type { Blocker, Standup } from './types.js';

export type AckResult = 'acked' | 'already_acked' | 'not_tagged' | 'not_found';
export type UpdateResult = 'ok' | 'not_found' | 'resolved';
export type ResolveResult = 'resolved' | 'already_resolved' | 'not_allowed' | 'not_found';

export function blockerThreadKey(blocker: Blocker): string {
  return `blocker-${blocker.id}`;
}

/**
 * Collaboration on blockers: tag people (they get an interactive DM card),
 * acknowledge, post updates (broadcast to everyone involved + the team
 * space), and resolve explicitly. Tagged blockers are exempt from
 * auto-resolve — see Repo.resolveBlockersFor.
 */
export class BlockerService {
  constructor(
    private repo: Repo,
    private adapter: ChatAdapter,
    private now: () => DateTime = () => DateTime.utc(),
  ) {}

  /** Tag people on a blocker; each new tag gets a DM card. Returns a chat reply. */
  async tag(standup: Standup, blockerId: number, mentions: Mention[], taggedBy: Mention): Promise<string> {
    const blocker = await this.findIn(standup, blockerId);
    if (!blocker) return `No open blocker #${blockerId} in *${standup.name}* — see \`blockers\`.`;
    if (mentions.length === 0) return 'Mention who to tag, e.g. `blocker 12 tag @Asha`.';

    const tagged: string[] = [];
    for (const m of mentions) {
      const fresh = await this.repo.tagBlocker({
        blockerId: blocker.id,
        userName: m.userName,
        displayName: m.displayName,
        taggedBy: taggedBy.displayName,
        at: this.now().toISO()!,
      });
      if (!fresh) continue;
      tagged.push(m.displayName);
      try {
        await this.adapter.sendBlockerCard(
          m.userName,
          standup,
          blocker,
          `${taggedBy.displayName} tagged you on this blocker.`,
        );
      } catch {
        // The tag still stands; the daily nudge will retry the DM.
      }
    }
    if (tagged.length === 0) return 'Everyone mentioned was already tagged on this blocker.';

    await this.adapter.postText(
      standup.spaceName,
      `🤝 ${taggedBy.displayName} tagged ${tagged.join(', ')} on blocker #${blocker.id}: "${blocker.text}" (${blocker.displayName})`,
      blockerThreadKey(blocker),
    );
    return `✅ Tagged ${tagged.join(', ')} on blocker #${blocker.id} — they got a DM. It now needs an explicit \`blocker ${blocker.id} resolve\`.`;
  }

  async acknowledge(blockerId: number, user: Mention): Promise<AckResult> {
    const blocker = await this.repo.getBlockerById(blockerId);
    if (!blocker || blocker.resolvedDate) return 'not_found';
    const tags = await this.repo.listBlockerTags(blockerId);
    const mine = tags.find((t) => t.userName === user.userName);
    if (!mine) return 'not_tagged';
    if (mine.acknowledgedAt) return 'already_acked';
    await this.repo.ackBlockerTag(blockerId, user.userName, this.now().toISO()!);
    await this.notifyOwner(blocker, `✋ ${user.displayName} acknowledged your blocker: "${blocker.text}"`);
    return 'acked';
  }

  async addUpdate(blockerId: number, user: Mention, text: string): Promise<UpdateResult> {
    const blocker = await this.repo.getBlockerById(blockerId);
    if (!blocker) return 'not_found';
    if (blocker.resolvedDate) return 'resolved';
    await this.repo.addBlockerUpdate({
      blockerId,
      userName: user.userName,
      displayName: user.displayName,
      text,
      at: this.now().toISO()!,
    });
    // Acknowledge implicitly — posting an update is stronger than an ack.
    await this.repo.ackBlockerTag(blockerId, user.userName, this.now().toISO()!);
    const standup = (await this.repo.getStandupById(blocker.standupId))!;
    await this.broadcast(
      standup,
      blocker,
      `📝 Update on blocker #${blocker.id} ("${blocker.text}") from ${user.displayName}:\n${text}`,
      user.userName,
    );
    return 'ok';
  }

  /** Owner, tagged people, and standup admins may resolve. */
  async resolve(blockerId: number, user: Mention): Promise<ResolveResult> {
    const blocker = await this.repo.getBlockerById(blockerId);
    if (!blocker) return 'not_found';
    if (blocker.resolvedDate) return 'already_resolved';
    const standup = (await this.repo.getStandupById(blocker.standupId))!;
    const tags = await this.repo.listBlockerTags(blockerId);
    const allowed =
      blocker.userName === user.userName ||
      tags.some((t) => t.userName === user.userName) ||
      (await this.repo.isAdmin(standup.id, user.userName));
    if (!allowed) return 'not_allowed';

    const date = this.now().setZone(standup.timezone).toISODate()!;
    if (!(await this.repo.resolveBlocker(blockerId, date, user.displayName))) return 'already_resolved';
    await this.broadcast(
      standup,
      blocker,
      `✅ Blocker #${blocker.id} resolved by ${user.displayName}: "${blocker.text}" (open since ${blocker.openedDate})`,
      user.userName,
    );
    return 'resolved';
  }

  /** DM everyone involved (owner + tagged, minus the author) and post to the blocker's thread. */
  private async broadcast(standup: Standup, blocker: Blocker, text: string, exceptUserName: string): Promise<void> {
    const recipients = new Map<string, string>();
    recipients.set(blocker.userName, blocker.displayName);
    for (const t of await this.repo.listBlockerTags(blocker.id)) {
      recipients.set(t.userName, t.displayName);
    }
    recipients.delete(exceptUserName);
    for (const userName of recipients.keys()) {
      try {
        await this.adapter.sendDm(userName, text);
      } catch {
        // Best-effort: the space thread still carries the update.
      }
    }
    await this.adapter.postText(standup.spaceName, text, blockerThreadKey(blocker));
  }

  private async notifyOwner(blocker: Blocker, text: string): Promise<void> {
    try {
      await this.adapter.sendDm(blocker.userName, text);
    } catch {
      // Non-critical notification.
    }
  }

  private async findIn(standup: Standup, blockerId: number): Promise<Blocker | null> {
    const blocker = await this.repo.getBlockerById(blockerId);
    if (!blocker || blocker.standupId !== standup.id || blocker.resolvedDate) return null;
    return blocker;
  }
}
