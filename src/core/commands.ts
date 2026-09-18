import { DateTime } from 'luxon';
import { createStandup } from './create-standup.js';
import type { ChatAdapter } from './adapter.js';
import { runProgress } from './progress.js';
import { isEscalateDays, isReminderMinutes, isValidTime, isValidZone, LIMITS, parseDays } from './validation.js';
import type { BlockerService } from './blocker-service.js';
import type { PollService } from './poll-service.js';
import { parseDateSpec, type Actor, type ScheduleService } from './schedule.js';
import type { SettingsService } from './settings.js';
import type { Repo } from '../db/repo.js';
import { trendsText } from './insights.js';
import { DEFAULT_QUESTIONS, standupQuestions, type Standup } from './types.js';

export interface Mention {
  userName: string;
  displayName: string;
}

export interface CommandContext {
  tenantId: string;
  spaceName: string;
  /** Message text with the bot mention already stripped. */
  text: string;
  /** Users @mentioned in the message (bot excluded). */
  mentions: Mention[];
  /** Who sent the command. */
  sender: Mention;
}

const HELP_SHORT = `*AsyncUp — the essentials* (mention me in this space):
\`setup [name]\` — create a standup reporting to this space (you become its admin)
\`add @user…\` — add participants
\`run now\` — open today's run immediately and prompt everyone (try it!)
\`time HH:MM\` · \`deadline HH:MM\` · \`timezone <IANA>\` · \`days mon,tue,…\` — schedule
\`status\` — configuration + today's progress
\`help all\` — every command (questions, mood, blockers, digests, AI, export…)`;

const HELP_ALL = `*AsyncUp commands* (mention me in this space — prefix with \`#<id>\` when the space has several standups):
\`setup [name]\` — create a standup reporting to this space (creator becomes admin)
\`run now\` — open today's run immediately and prompt everyone
\`archive\` — retire a standup (history stays; prompts stop)
\`add @user…\` / \`remove @user…\` — manage participants
\`mandatory @user…\` / \`optional @user…\` — who counts toward the report
\`vacation @user…\` / \`back @user…\` — mark people away (they can also DM me \`vacation\`/\`back\`)
\`off @user <date|range> [reason]\` / \`working @user <date>\` — mark someone away or working on given days (\`off @user cancel <date>\` undoes)
\`days @user mon-thu|adhoc|reset\` — someone's personal week
\`admin @user…\` / \`unadmin @user…\` — who may change configuration
\`time HH:MM\` — prompt time (participant's local time)
\`deadline HH:MM\` — close time (standup timezone)
\`remind <minutes>\` — nudge before the deadline (0 = off)
\`timezone <IANA>\` · \`days mon,tue,…\` — schedule
\`questions\` / \`questions set Q1 | Q2 | …\` / \`questions reset\` — customize the form
\`mood on|off|anon\` — mood question (\`anon\` hides who felt what; the wrap-up shows the team average)
\`escalate @user\` / \`escalate days N\` / \`escalate off\` — DM someone when blockers stay open
\`digest on|off\` — weekly digest
\`blocker <id> tag @user…\` / \`blocker <id> update <text>\` / \`blocker <id> resolve\` — work a blocker together
\`poll Question? | Option A | Option B\` — team poll in the space (\`polls\`, \`poll <id> results\`, \`poll <id> close\`)
\`status\` · \`trends\` · \`blockers\` · \`export\` — insights`;

/** Commands anyone in the space may run; everything else needs an admin. */
const OPEN_COMMANDS = new Set(['help', 'status', 'trends', 'blockers', 'blocker', 'export', 'poll', 'polls']);

/** The slice of the scheduler `run now` needs (avoids a circular dependency). */
export interface RunNowRunner {
  runNow(standup: Standup): Promise<'started' | 'already_open' | 'already_closed' | 'no_participants'>;
}

export class CommandHandler {
  private runner: RunNowRunner | null = null;

  constructor(
    private repo: Repo,
    private settings: SettingsService,
    private now: () => DateTime = () => DateTime.utc(),
    private blockerService: BlockerService | null = null,
    private adapter: ChatAdapter | null = null,
    private pollService: PollService | null = null,
    private schedule: ScheduleService | null = null,
  ) {}

  /** The scheduler is constructed after the handler; attach it once built. */
  attachRunner(runner: RunNowRunner): void {
    this.runner = runner;
  }

  async handle(ctx: CommandContext): Promise<string> {
    const tokens = ctx.text.trim().split(/\s+/).filter(Boolean);

    let standupRef: number | null = null;
    const refMatch = tokens[0]?.match(/^#(\d+)$/);
    if (refMatch) {
      standupRef = Number(refMatch[1]);
      tokens.shift();
    }

    const [verb = '', ...rest] = tokens;
    const command = verb.toLowerCase();
    const arg = rest.join(' ').trim();

    if (command === '' || command === 'help') {
      return arg.toLowerCase() === 'all' ? HELP_ALL : HELP_SHORT;
    }
    if (command === 'setup') return this.setup(ctx, arg);

    const standups = await this.repo.listStandupsBySpace(ctx.tenantId, ctx.spaceName);
    if (standups.length === 0) {
      return 'No standup is configured for this space yet. Run `setup` first.';
    }

    if (command === 'status' && standupRef === null) {
      return (await Promise.all(standups.map((s) => this.status(s, standups.length > 1)))).join('\n\n');
    }

    let standup: Standup;
    if (standupRef !== null) {
      const found = standups.find((s) => s.id === standupRef);
      if (!found) return `No standup #${standupRef} in this space. ${listStandups(standups)}`;
      standup = found;
    } else if (standups.length === 1) {
      standup = standups[0]!;
    } else {
      return `This space has several standups — prefix your command with the id, e.g. \`#${standups[0]!.id} ${command}\`.\n${listStandups(standups)}`;
    }

    if (!OPEN_COMMANDS.has(command)) {
      const denied = await this.requireAdmin(standup, ctx.sender);
      if (denied) return denied;
    }

    switch (command) {
      case 'run':
        return this.runNow(standup, arg);
      case 'archive':
        return this.archive(standup);
      case 'add':
        return this.addParticipants(standup, ctx.mentions);
      case 'remove':
        return this.removeParticipants(standup, ctx.mentions);
      case 'mandatory':
        return this.setMandatory(standup, ctx.mentions, true);
      case 'optional':
        return this.setMandatory(standup, ctx.mentions, false);
      case 'vacation':
        return this.setVacation(standup, ctx.mentions, true);
      case 'back':
        return this.setVacation(standup, ctx.mentions, false);
      case 'admin':
        return this.addAdmins(standup, ctx.mentions);
      case 'unadmin':
        return this.removeAdmins(standup, ctx.mentions);
      case 'time':
        return this.setTime(standup, arg, 'promptTime');
      case 'deadline':
        return this.setTime(standup, arg, 'deadlineTime');
      case 'remind':
        return this.setReminder(standup, arg);
      case 'timezone':
        return this.setTimezone(standup, arg);
      case 'days':
        return ctx.mentions.length > 0 ? this.personalWeek(standup, ctx, rest) : this.setDays(standup, arg);
      case 'off':
        return this.override(standup, ctx, rest, false);
      case 'working':
        return this.override(standup, ctx, rest, true);
      case 'questions':
        return this.questions(standup, rest);
      case 'mood':
        return this.mood(standup, arg);
      case 'escalate':
        return this.escalate(standup, ctx.mentions, rest);
      case 'digest':
        return this.toggle(standup, 'digestEnabled', arg, 'Weekly digest');
      case 'status':
        return this.status(standup, false);
      case 'trends':
        return await trendsText(this.repo, standup, this.now());
      case 'blockers':
        return this.blockers(standup);
      case 'blocker':
        return this.blockerCmd(standup, ctx, rest);
      case 'poll':
        return this.pollCmd(standup, ctx, rest);
      case 'polls':
        return this.pollList(standup);
      case 'export':
        return this.exportInfo(standup);
      default:
        return `Unknown command \`${verb}\`. Try \`help\`.`;
    }
  }

  /** Words left once the @mentions are taken out of the command text. */
  private withoutMentions(rest: string[], mentions: Mention[]): string {
    let text = rest.join(' ');
    for (const m of mentions) text = text.split(`@${m.displayName}`).join(' ').split(m.displayName).join(' ');
    return text.replace(/\s+/g, ' ').trim();
  }

  private actorFor(ctx: CommandContext, target: Mention): Actor {
    return { userName: ctx.sender.userName, displayName: ctx.sender.displayName, self: target.userName === ctx.sender.userName, manager: true };
  }

  private async personalWeek(standup: Standup, ctx: CommandContext, rest: string[]): Promise<string> {
    if (!this.schedule) return 'Personal schedules are not available on this install.';
    const target = ctx.mentions[0]!;
    const value = this.withoutMentions(rest, ctx.mentions);
    const result = await this.schedule.setWorkingDays(target, value, this.actorFor(ctx, target), 'chat');
    return result.message;
  }

  private async override(standup: Standup, ctx: CommandContext, rest: string[], working: boolean): Promise<string> {
    if (!this.schedule) return 'Personal schedules are not available on this install.';
    const target = ctx.mentions[0];
    if (!target) return `Mention the person, e.g. \`${working ? 'working' : 'off'} @Asha tomorrow${working ? '' : ' comp off'}\`.`;
    const text = this.withoutMentions(rest, ctx.mentions);
    const now = this.now().setZone(standup.timezone);
    if (/^cancel\b/i.test(text)) {
      const spec = parseDateSpec(text.replace(/^cancel\s*/i, ''), now);
      if (!spec.ok) return spec.message;
      return (await this.schedule.cancelOverride(target, spec.dates[0]!, this.actorFor(ctx, target))).message;
    }
    const spec = parseDateSpec(text, now);
    if (!spec.ok) return spec.message;
    const result = await this.schedule.setOverride({ target, dates: spec.dates, working, reason: spec.rest, actor: this.actorFor(ctx, target), channel: 'chat' });
    return result.message;
  }

  private async requireAdmin(standup: Standup, sender: Mention): Promise<string | null> {
    const admins = await this.repo.listAdmins(standup.id);
    if (admins.length === 0 || admins.some((a) => a.userName === sender.userName)) return null;
    return `🔒 Only admins of *${standup.name}* can change its configuration (${admins
      .map((a) => a.displayName)
      .join(', ')}).`;
  }

  private async setup(ctx: CommandContext, name: string): Promise<string> {
    const creator = ctx.sender.userName ? { userName: ctx.sender.userName, displayName: ctx.sender.displayName } : null;
    const result = await createStandup(
      this.repo,
      this.settings,
      ctx.tenantId,
      { name: name || 'Daily Standup', spaceName: ctx.spaceName },
      creator,
    );
    if (!result.ok) {
      if (result.code !== 'duplicate') return `⚠️ ${result.message}`;
      const { duplicate } = result;
      return (
        `⚠️ This space already has a standup named *${duplicate.name}* (#${duplicate.id}) — nothing was created.\n` +
        `Configure it with \`#${duplicate.id} <command>\`, pick a different name (\`setup <name>\`), or retire it first with \`#${duplicate.id} archive\`.`
      );
    }
    const { standup, siblings } = result;
    const tzTip =
      standup.timezone === 'UTC'
        ? `\n⚠️ Timezone is *UTC* — prompts land at ${standup.promptTime} UTC. Set yours with \`timezone Asia/Kolkata\`-style, or change the default under Settings › General.`
        : '';
    return (
      `✅ Standup *${standup.name}* created (#${standup.id})${siblings > 1 ? ` — this space now has ${siblings} standups, prefix commands with \`#${standup.id}\`` : ''}. You are its admin.\n` +
      `Defaults: prompt ${standup.promptTime}, deadline ${standup.deadlineTime}, reminder ${standup.reminderMinutesBefore}m before, ${standup.timezone}, ${standup.days}.${tzTip}\n` +
      `Next: \`add @user…\` to add participants, then \`run now\` to see the whole flow immediately.`
    );
  }

  private async runNow(standup: Standup, arg: string): Promise<string> {
    if (arg.toLowerCase() !== 'now') return 'Use `run now` to open today\'s run immediately.';
    if (!this.runner) return 'Run-now is not available.';
    const result = await this.runner.runNow(standup);
    const messages = {
      started: `🚀 Today's run for *${standup.name}* is open — everyone eligible was just prompted. The wrap-up posts at the ${standup.deadlineTime} ${standup.timezone} deadline.`,
      already_open: `Today's run is already open — anyone not yet prompted was just prompted.`,
      already_closed: `Today's run already closed. The next one opens on schedule.`,
      no_participants: 'No one to prompt — `add @user…` first (or everyone is on vacation).',
    };
    return messages[result];
  }

  private async archive(standup: Standup): Promise<string> {
    await this.repo.updateStandup(standup.id, { active: false });
    return (
      `🗄️ Standup *${standup.name}* (#${standup.id}) archived — no more prompts or reports. ` +
      `History stays in the database and exports. \`setup <name>\` starts a fresh one.`
    );
  }

  private async addParticipants(standup: Standup, mentions: Mention[]): Promise<string> {
    if (mentions.length === 0) return 'Mention the people to add, e.g. `add @Asha @Rohit`.';
    const unreachable: string[] = [];
    for (const m of mentions) {
      await this.repo.upsertParticipant({
        standupId: standup.id,
        userName: m.userName,
        displayName: m.displayName,
      });
      if (this.adapter && !(await this.adapter.canDm(m.userName))) unreachable.push(m.displayName);
    }
    let reply = `✅ Added ${mentions.map((m) => m.displayName).join(', ')} (mandatory). Use \`optional @user\` to exclude someone from the report count.`;
    if (unreachable.length > 0) {
      reply +=
        `\n⚠️ Can't DM ${unreachable.join(', ')} yet — they need the Chat app installed ` +
        `(they can add it themselves, or an admin installs it for everyone). They won't get prompts until then.`;
    }
    return reply;
  }

  private async removeParticipants(standup: Standup, mentions: Mention[]): Promise<string> {
    if (mentions.length === 0) return 'Mention the people to remove, e.g. `remove @Asha`.';
    const removed: string[] = [];
    const unknown: string[] = [];
    for (const m of mentions) {
      ((await this.repo.removeParticipant(standup.id, m.userName)) ? removed : unknown).push(m.displayName);
    }
    const parts: string[] = [];
    if (removed.length) parts.push(`✅ Removed ${removed.join(', ')}.`);
    if (unknown.length) parts.push(`⚠️ Not participants: ${unknown.join(', ')}.`);
    return parts.join(' ');
  }

  private async setMandatory(standup: Standup, mentions: Mention[], mandatory: boolean): Promise<string> {
    if (mentions.length === 0) {
      return `Mention the people to mark as ${mandatory ? 'mandatory' : 'optional'}.`;
    }
    const changed: string[] = [];
    const unknown: string[] = [];
    for (const m of mentions) {
      ((await this.repo.setParticipantMandatory(standup.id, m.userName, mandatory)) ? changed : unknown).push(
        m.displayName,
      );
    }
    const parts: string[] = [];
    if (changed.length) parts.push(`✅ ${changed.join(', ')} now ${mandatory ? 'mandatory' : 'optional'}.`);
    if (unknown.length) parts.push(`⚠️ Not participants: ${unknown.join(', ')}. Use \`add\` first.`);
    return parts.join(' ');
  }

  private async setVacation(standup: Standup, mentions: Mention[], onVacation: boolean): Promise<string> {
    if (mentions.length === 0) {
      return `Mention the people, e.g. \`${onVacation ? 'vacation' : 'back'} @Asha\`.`;
    }
    const changed: string[] = [];
    const unknown: string[] = [];
    for (const m of mentions) {
      ((await this.repo.setParticipantVacation(standup.id, m.userName, onVacation)) ? changed : unknown).push(
        m.displayName,
      );
    }
    const parts: string[] = [];
    if (changed.length) {
      parts.push(
        onVacation
          ? `🏖️ ${changed.join(', ')} marked as away — no prompts, not counted as missing.`
          : `👋 ${changed.join(', ')} back — prompts resume with the next run.`,
      );
    }
    if (unknown.length) parts.push(`⚠️ Not participants: ${unknown.join(', ')}.`);
    return parts.join(' ');
  }

  private async addAdmins(standup: Standup, mentions: Mention[]): Promise<string> {
    if (mentions.length === 0) return 'Mention the people to make admins, e.g. `admin @Asha`.';
    for (const m of mentions) await this.repo.addAdmin(standup.id, m.userName, m.displayName);
    return `✅ Admins now: ${(await this.repo.listAdmins(standup.id)).map((a) => a.displayName).join(', ')}.`;
  }

  private async removeAdmins(standup: Standup, mentions: Mention[]): Promise<string> {
    if (mentions.length === 0) return 'Mention the admins to remove, e.g. `unadmin @Asha`.';
    const admins = await this.repo.listAdmins(standup.id);
    const remaining = admins.filter((a) => !mentions.some((m) => m.userName === a.userName));
    if (admins.length > 0 && remaining.length === 0) {
      return '⚠️ A standup must keep at least one admin — add another admin first.';
    }
    for (const m of mentions) await this.repo.removeAdmin(standup.id, m.userName);
    const now = await this.repo.listAdmins(standup.id);
    return `✅ Admins now: ${now.length ? now.map((a) => a.displayName).join(', ') : 'none (configuration is open to everyone)'}.`;
  }

  private async setTime(standup: Standup, value: string, field: 'promptTime' | 'deadlineTime'): Promise<string> {
    if (!isValidTime(value)) return 'Please give a 24h time like `09:30`.';
    const next = { promptTime: standup.promptTime, deadlineTime: standup.deadlineTime, [field]: value };
    if (next.promptTime >= next.deadlineTime) {
      return `⚠️ Prompt time (${next.promptTime}) must be before the deadline (${next.deadlineTime}).`;
    }
    await this.repo.updateStandup(standup.id, { [field]: value });
    return field === 'promptTime'
      ? `✅ Prompts will go out at ${value} (each participant's local time).`
      : `✅ Deadline set to ${value} ${standup.timezone}. The report posts then.`;
  }

  private async setReminder(standup: Standup, value: string): Promise<string> {
    const minutes = Number(value);
    if (!isReminderMinutes(minutes)) {
      return 'Please give the number of minutes before the deadline, e.g. `remind 60`. Use `remind 0` to disable.';
    }
    await this.repo.updateStandup(standup.id, { reminderMinutesBefore: minutes });
    return minutes === 0
      ? '✅ Reminder disabled.'
      : `✅ Reminder will go out ${minutes} minutes before the deadline.`;
  }

  private async setTimezone(standup: Standup, value: string): Promise<string> {
    if (!value || !isValidZone(value)) {
      return 'Please give a valid IANA timezone, e.g. `timezone Asia/Kolkata`.';
    }
    await this.repo.updateStandup(standup.id, { timezone: value });
    return `✅ Timezone set to ${value}.`;
  }

  private async setDays(standup: Standup, value: string): Promise<string> {
    const ordered = parseDays(value);
    if (!ordered) {
      return 'Please list days like `days mon,tue,wed,thu,fri`.';
    }
    await this.repo.updateStandup(standup.id, { days: ordered.join(',') });
    return `✅ Standup runs on: ${ordered.join(', ')}.`;
  }

  private async questions(standup: Standup, rest: string[]): Promise<string> {
    const sub = (rest[0] ?? '').toLowerCase();
    if (sub === 'reset') {
      await this.repo.updateStandup(standup.id, { questions: null });
      return `✅ Questions reset to the defaults:\n${DEFAULT_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
    }
    if (sub === 'set') {
      const parts = rest
        .slice(1)
        .join(' ')
        .split('|')
        .map((q) => q.trim())
        .filter(Boolean);
      if (parts.length === 0 || parts.length > LIMITS.questionsMax) {
        return 'Give 1–10 questions separated by `|`, e.g. `questions set What shipped? | What is next? | Any blockers?`';
      }
      const tooLong = parts.find((q) => q.length > LIMITS.textMax);
      if (tooLong) return `⚠️ Question too long (max 200 chars): "${tooLong.slice(0, 50)}…"`;
      await this.repo.updateStandup(standup.id, { questions: parts });
      return `✅ Questions updated:\n${parts.map((q, i) => `${i + 1}. ${q}`).join('\n')}\nApplies from the next run.`;
    }
    const current = standupQuestions(standup);
    return (
      `*Questions for ${standup.name}:*\n${current.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n` +
      '`questions set Q1 | Q2 | …` to change · `questions reset` for defaults.'
    );
  }

  private async mood(standup: Standup, value: string): Promise<string> {
    switch (value.toLowerCase()) {
      case 'on':
        await this.repo.updateStandup(standup.id, { moodEnabled: true, moodAnonymous: false });
        return '✅ Mood question on — moods show on each card.';
      case 'anon':
      case 'anonymous':
        await this.repo.updateStandup(standup.id, { moodEnabled: true, moodAnonymous: true });
        return '✅ Mood question on, *anonymous* — cards hide who felt what; the wrap-up shows the team average instead.';
      case 'off':
        await this.repo.updateStandup(standup.id, { moodEnabled: false });
        return '✅ Mood question off.';
      default:
        return 'Use `mood on`, `mood anon`, or `mood off`.';
    }
  }

  private async escalate(standup: Standup, mentions: Mention[], rest: string[]): Promise<string> {
    const sub = (rest[0] ?? '').toLowerCase();
    if (sub === 'off') {
      await this.repo.updateStandup(standup.id, { escalateUserName: null, escalateDisplayName: null });
      return '✅ Blocker escalation off.';
    }
    if (sub === 'days') {
      const days = Number(rest[1]);
      if (!isEscalateDays(days)) {
        return 'Give the number of days a blocker may stay open, e.g. `escalate days 3`.';
      }
      await this.repo.updateStandup(standup.id, { escalateAfterDays: days });
      return `✅ Blockers escalate after ${days} day${days === 1 ? '' : 's'} open.`;
    }
    const contact = mentions[0];
    if (!contact) {
      return standup.escalateUserName
        ? `Escalation: DM ${standup.escalateDisplayName} when blockers are open ${standup.escalateAfterDays}+ days. \`escalate @user\`, \`escalate days N\`, or \`escalate off\` to change.`
        : 'Mention who should be pinged, e.g. `escalate @Asha` — they get a DM when blockers stay open too long.';
    }
    await this.repo.updateStandup(standup.id, {
      escalateUserName: contact.userName,
      escalateDisplayName: contact.displayName,
    });
    return `✅ ${contact.displayName} will be DMed when blockers stay open ${standup.escalateAfterDays}+ days.`;
  }

  private async toggle(
    standup: Standup,
    field: 'moodEnabled' | 'digestEnabled',
    value: string,
    label: string,
  ): Promise<string> {
    const v = value.toLowerCase();
    if (v !== 'on' && v !== 'off') return `Use \`on\` or \`off\`, e.g. \`${label.split(' ')[0]?.toLowerCase()} on\`.`;
    await this.repo.updateStandup(standup.id, { [field]: v === 'on' });
    return `✅ ${label} ${v}.`;
  }

  private async blockers(standup: Standup): Promise<string> {
    const open = await this.repo.listOpenBlockers(standup.id);
    if (open.length === 0) return `✅ No open blockers for *${standup.name}*.`;
    const today = this.now().setZone(standup.timezone);
    const lines: string[] = [];
    for (const b of open) {
      const age = Math.max(0, Math.floor(today.diff(DateTime.fromISO(b.openedDate), 'days').days));
      const tags = await this.repo.listBlockerTags(b.id);
      const updates = await this.repo.listBlockerUpdates(b.id);
      let line = `⚠️ #${b.id} ${b.displayName}: ${b.text} _(${age}d old)_`;
      if (tags.length > 0) {
        line += ` · tagged: ${tags.map((t) => `${t.displayName}${t.acknowledgedAt ? ' ✋' : ''}`).join(', ')}`;
      }
      if (updates.length > 0) line += ` · ${updates.length} update${updates.length === 1 ? '' : 's'}`;
      lines.push(line);
    }
    return (
      `*Open blockers — ${standup.name}:*\n${lines.join('\n')}\n` +
      'Work one with `blocker <id> tag @user`, `blocker <id> update <text>`, `blocker <id> resolve`. ' +
      'Untagged blockers also auto-resolve on the next blocker-free standup.'
    );
  }

  private async blockerCmd(standup: Standup, ctx: CommandContext, rest: string[]): Promise<string> {
    if (!this.blockerService) return 'Blocker collaboration is not available.';
    const id = Number(rest[0]);
    const sub = (rest[1] ?? '').toLowerCase();
    if (!Number.isInteger(id) || !['tag', 'update', 'resolve'].includes(sub)) {
      return 'Usage: `blocker <id> tag @user…` · `blocker <id> update <text>` · `blocker <id> resolve` — ids are shown by `blockers`.';
    }
    if (sub === 'tag') {
      return this.blockerService.tag(standup, id, ctx.mentions, ctx.sender);
    }
    if (sub === 'update') {
      const text = rest.slice(2).join(' ').trim();
      if (!text) return 'Add the update text, e.g. `blocker 12 update keys requested from infra`.';
      const result = await this.blockerService.addUpdate(id, ctx.sender, text);
      const messages = {
        ok: `📝 Update posted on blocker #${id} — everyone involved was notified.`,
        resolved: `Blocker #${id} is already resolved.`,
        not_found: `No blocker #${id}.`,
      };
      return messages[result];
    }
    const result = await this.blockerService.resolve(id, ctx.sender);
    const messages = {
      resolved: `✅ Blocker #${id} resolved — everyone involved was notified.`,
      already_resolved: `Blocker #${id} was already resolved.`,
      not_allowed: 'Only the reporter, tagged people, or a standup admin can resolve this blocker.',
      not_found: `No blocker #${id}.`,
    };
    return messages[result];
  }

  private async pollCmd(standup: Standup, ctx: CommandContext, rest: string[]): Promise<string> {
    if (!this.pollService) return 'Polls are not available.';
    const id = Number(rest[0]);
    const sub = (rest[1] ?? '').toLowerCase();

    if (Number.isInteger(id) && (sub === 'close' || sub === 'results')) {
      if (sub === 'results') {
        const poll = await this.repo.getPollById(id);
        if (!poll || poll.standupId !== standup.id) return `No poll #${id} here.`;
        return this.pollService.resultsText(poll, !!poll.closedAt);
      }
      const result = await this.pollService.close(standup, id, ctx.sender);
      const messages = {
        closed: `✅ Poll #${id} closed — results posted to the space.`,
        already_closed: `Poll #${id} is already closed.`,
        not_allowed: 'Only the poll creator or a standup admin can close it.',
        not_found: `No poll #${id} here.`,
      };
      return messages[result];
    }

    const parts = rest
      .join(' ')
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean);
    if (parts.length < 3 || parts.length > 7) {
      return 'Start a poll with `poll Question? | Option A | Option B` (2–6 options). Also: `poll <id> results`, `poll <id> close`, `polls`.';
    }
    const tooLong = parts.find((t) => t.length > LIMITS.textMax);
    if (tooLong) return `⚠️ Too long (max 200 chars): "${tooLong.slice(0, 50)}…"`;
    const [question, ...options] = parts;
    const poll = await this.pollService.create(standup, question!, options, ctx.sender);
    return `📊 Poll *#${poll.id}* posted — vote on the card. \`poll ${poll.id} close\` posts the results.`;
  }

  private async pollList(standup: Standup): Promise<string> {
    const open = await this.repo.listOpenPolls(standup.id);
    if (open.length === 0) {
      return 'No open polls. Start one with `poll Question? | Option A | Option B`.';
    }
    const lines: string[] = [];
    for (const poll of open) {
      const total = (await this.repo.listPollVotes(poll.id)).length;
      lines.push(`#${poll.id} ${poll.question} — ${total} vote${total === 1 ? '' : 's'} (by ${poll.createdDisplay})`);
    }
    return `*Open polls:*\n${lines.join('\n')}\n\`poll <id> results\` · \`poll <id> close\``;
  }

  private exportInfo(standup: Standup): string {
    return (
      `Export *${standup.name}* (#${standup.id}) as CSV via the HTTP endpoint:\n` +
      '`GET /export?standupId=' +
      String(standup.id) +
      '&days=30` with header `Authorization: Bearer <export token>`.\n' +
      'The endpoint is disabled until an export token is generated under Settings › API & tokens.'
    );
  }

  private async status(standup: Standup, withId: boolean): Promise<string> {
    const participants = await this.repo.listParticipants(standup.id);
    const admins = await this.repo.listAdmins(standup.id);
    const toggles = [
      standup.moodEnabled ? (standup.moodAnonymous ? 'mood ✓ (anon)' : 'mood ✓') : 'mood ✗',
      standup.digestEnabled ? 'digest ✓' : 'digest ✗',
      standup.escalateUserName
        ? `escalate → ${standup.escalateDisplayName} (${standup.escalateAfterDays}d)`
        : 'escalate ✗',
      standup.questions ? `${standup.questions.length} custom questions` : 'default questions',
    ].join(' · ');
    const lines = [
      `*${standup.name}*${withId ? ` (#${standup.id})` : ''}`,
      `Prompt ${standup.promptTime} (participant local) · deadline ${standup.deadlineTime} ${standup.timezone} · reminder ${standup.reminderMinutesBefore}m before · ${standup.days}`,
      toggles,
      participants.length
        ? `Participants: ${participants
            .map(
              (p) =>
                `${p.displayName}${p.mandatory ? '' : ' (optional)'}${p.onVacation ? ' 🏖️' : ''}`,
            )
            .join(', ')}`
        : 'Participants: none yet — use `add @user`.',
      admins.length ? `Admins: ${admins.map((a) => a.displayName).join(', ')}` : 'Admins: none (open config)',
    ];

    const today = this.now().setZone(standup.timezone).toISODate()!;
    const run = await this.repo.getRun(standup.id, today);
    if (run) {
      const progress = runProgress(
        await this.repo.listRunParticipants(run.id),
        await this.repo.listSubmissions(run.id),
      );
      const names = (people: { displayName: string }[]) => people.map((p) => p.displayName).join(', ');
      lines.push(
        `Today (${run.date}, ${run.status}): ${progress.submitted}/${progress.expected} submitted.` +
          (progress.done.length ? ` ✅ ${names(progress.done)}.` : '') +
          (progress.pending.length ? ` ⏳ ${names(progress.pending)}.` : '') +
          (progress.away.length ? ` 🏖️ ${names(progress.away)}.` : ''),
      );
    } else {
      lines.push(`No run yet today (${today}).`);
    }
    return lines.join('\n');
  }
}

function listStandups(standups: Standup[]): string {
  return standups.map((s) => `#${s.id} ${s.name}`).join(' · ');
}
