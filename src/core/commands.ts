import { DateTime, IANAZone } from 'luxon';
import type { Repo } from '../db/repo.js';
import { trendsText } from './insights.js';
import {
  DEFAULT_QUESTIONS,
  standupQuestions,
  WEEKDAYS,
  type Standup,
  type Weekday,
} from './types.js';

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

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const HELP = `*AsyncUp commands* (mention me in this space — prefix with \`#<id>\` when the space has several standups):
\`setup [name]\` — create a standup reporting to this space (creator becomes admin)
\`add @user…\` / \`remove @user…\` — manage participants
\`mandatory @user…\` / \`optional @user…\` — who counts toward the report
\`vacation @user…\` / \`back @user…\` — mark people away (they can also DM me \`vacation\`/\`back\`)
\`admin @user…\` / \`unadmin @user…\` — who may change configuration
\`time HH:MM\` — prompt time (participant's local time)
\`deadline HH:MM\` — close time (standup timezone)
\`remind <minutes>\` — nudge before the deadline (0 = off)
\`timezone <IANA>\` · \`days mon,tue,…\` — schedule
\`questions\` / \`questions set Q1 | Q2 | …\` / \`questions reset\` — customize the form
\`mood on|off|anon\` — mood question (\`anon\` hides who felt what; the wrap-up shows the team average)
\`escalate @user\` / \`escalate days N\` / \`escalate off\` — DM someone when blockers stay open
\`digest on|off\` · \`ai on|off\` — weekly digest, AI summaries
\`status\` · \`trends\` · \`blockers\` · \`export\` — insights`;

/** Commands anyone in the space may run; everything else needs an admin. */
const OPEN_COMMANDS = new Set(['help', 'status', 'trends', 'blockers', 'export']);

export class CommandHandler {
  constructor(
    private repo: Repo,
    private defaultTimezone: string,
    private now: () => DateTime = () => DateTime.utc(),
  ) {}

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

    if (command === '' || command === 'help') return HELP;
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
        return this.setDays(standup, arg);
      case 'questions':
        return this.questions(standup, rest);
      case 'mood':
        return this.mood(standup, arg);
      case 'escalate':
        return this.escalate(standup, ctx.mentions, rest);
      case 'digest':
        return this.toggle(standup, 'digestEnabled', arg, 'Weekly digest');
      case 'ai':
        return this.toggle(standup, 'aiEnabled', arg, 'AI summaries');
      case 'status':
        return this.status(standup, false);
      case 'trends':
        return await trendsText(this.repo, standup, this.now());
      case 'blockers':
        return this.blockers(standup);
      case 'export':
        return this.exportInfo(standup);
      default:
        return `Unknown command \`${verb}\`. Try \`help\`.`;
    }
  }

  private async requireAdmin(standup: Standup, sender: Mention): Promise<string | null> {
    const admins = await this.repo.listAdmins(standup.id);
    if (admins.length === 0 || admins.some((a) => a.userName === sender.userName)) return null;
    return `🔒 Only admins of *${standup.name}* can change its configuration (${admins
      .map((a) => a.displayName)
      .join(', ')}).`;
  }

  private async setup(ctx: CommandContext, name: string): Promise<string> {
    const standup = await this.repo.createStandup({
      tenantId: ctx.tenantId,
      spaceName: ctx.spaceName,
      name: name || 'Daily Standup',
      timezone: this.defaultTimezone,
    });
    if (ctx.sender.userName) {
      await this.repo.addAdmin(standup.id, ctx.sender.userName, ctx.sender.displayName);
    }
    const siblings = await this.repo.listStandupsBySpace(ctx.tenantId, ctx.spaceName);
    return (
      `✅ Standup *${standup.name}* created (#${standup.id})${siblings.length > 1 ? ` — this space now has ${siblings.length} standups, prefix commands with \`#${standup.id}\`` : ''}. You are its admin.\n` +
      `Defaults: prompt ${standup.promptTime}, deadline ${standup.deadlineTime}, reminder ${standup.reminderMinutesBefore}m before, ${standup.timezone}, ${standup.days}.\n` +
      `Next: \`add @user…\` to add participants.`
    );
  }

  private async addParticipants(standup: Standup, mentions: Mention[]): Promise<string> {
    if (mentions.length === 0) return 'Mention the people to add, e.g. `add @Asha @Rohit`.';
    for (const m of mentions) {
      await this.repo.upsertParticipant({
        standupId: standup.id,
        userName: m.userName,
        displayName: m.displayName,
      });
    }
    return `✅ Added ${mentions.map((m) => m.displayName).join(', ')} (mandatory). Use \`optional @user\` to exclude someone from the report count.`;
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
    if (!TIME_RE.test(value)) return 'Please give a 24h time like `09:30`.';
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
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
      return 'Please give the number of minutes before the deadline, e.g. `remind 60`. Use `remind 0` to disable.';
    }
    await this.repo.updateStandup(standup.id, { reminderMinutesBefore: minutes });
    return minutes === 0
      ? '✅ Reminder disabled.'
      : `✅ Reminder will go out ${minutes} minutes before the deadline.`;
  }

  private async setTimezone(standup: Standup, value: string): Promise<string> {
    if (!value || !IANAZone.isValidZone(value)) {
      return 'Please give a valid IANA timezone, e.g. `timezone Asia/Kolkata`.';
    }
    await this.repo.updateStandup(standup.id, { timezone: value });
    return `✅ Timezone set to ${value}.`;
  }

  private async setDays(standup: Standup, value: string): Promise<string> {
    const days = value
      .toLowerCase()
      .split(/[,\s]+/)
      .filter(Boolean) as Weekday[];
    const invalid = days.filter((d) => !WEEKDAYS.includes(d));
    if (days.length === 0 || invalid.length > 0) {
      return 'Please list days like `days mon,tue,wed,thu,fri`.';
    }
    const ordered = WEEKDAYS.filter((d) => days.includes(d));
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
      if (parts.length === 0 || parts.length > 10) {
        return 'Give 1–10 questions separated by `|`, e.g. `questions set What shipped? | What is next? | Any blockers?`';
      }
      const tooLong = parts.find((q) => q.length > 200);
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
      if (!Number.isInteger(days) || days < 1 || days > 30) {
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
    field: 'moodEnabled' | 'digestEnabled' | 'aiEnabled',
    value: string,
    label: string,
  ): Promise<string> {
    const v = value.toLowerCase();
    if (v !== 'on' && v !== 'off') return `Use \`on\` or \`off\`, e.g. \`${label.split(' ')[0]?.toLowerCase()} on\`.`;
    await this.repo.updateStandup(standup.id, { [field]: v === 'on' });
    if (field === 'aiEnabled' && v === 'on') {
      return `✅ ${label} on. Requires LLM_PROVIDER + LLM_API_KEY in the server environment — summaries are skipped silently otherwise.`;
    }
    return `✅ ${label} ${v}.`;
  }

  private async blockers(standup: Standup): Promise<string> {
    const open = await this.repo.listOpenBlockers(standup.id);
    if (open.length === 0) return `✅ No open blockers for *${standup.name}*.`;
    const today = this.now().setZone(standup.timezone);
    const lines = open.map((b) => {
      const age = Math.max(0, Math.floor(today.diff(DateTime.fromISO(b.openedDate), 'days').days));
      return `⚠️ ${b.displayName}: ${b.text} _(${age}d old)_`;
    });
    return `*Open blockers — ${standup.name}:*\n${lines.join('\n')}\nBlockers auto-resolve when the person submits a blocker-free standup.`;
  }

  private exportInfo(standup: Standup): string {
    return (
      `Export *${standup.name}* (#${standup.id}) as CSV via the HTTP endpoint:\n` +
      '`GET /export?standupId=' +
      String(standup.id) +
      '&days=30` with header `Authorization: Bearer $EXPORT_TOKEN`.\n' +
      'The endpoint is disabled until the EXPORT_TOKEN environment variable is set on the server.'
    );
  }

  private async status(standup: Standup, withId: boolean): Promise<string> {
    const participants = await this.repo.listParticipants(standup.id);
    const admins = await this.repo.listAdmins(standup.id);
    const toggles = [
      standup.moodEnabled ? (standup.moodAnonymous ? 'mood ✓ (anon)' : 'mood ✓') : 'mood ✗',
      standup.digestEnabled ? 'digest ✓' : 'digest ✗',
      standup.aiEnabled ? 'ai ✓' : 'ai ✗',
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
      const submitted = new Set((await this.repo.listSubmissions(run.id)).map((s) => s.userName));
      const roster = await this.repo.listRunParticipants(run.id);
      const done = roster.filter((p) => submitted.has(p.userName)).map((p) => p.displayName);
      const away = roster
        .filter((p) => !submitted.has(p.userName) && (p.skippedAt || p.onVacation))
        .map((p) => p.displayName);
      const pending = roster
        .filter((p) => !submitted.has(p.userName) && !p.skippedAt && !p.onVacation)
        .map((p) => p.displayName);
      lines.push(
        `Today (${run.date}, ${run.status}): ${done.length}/${roster.length - away.length} submitted.` +
          (done.length ? ` ✅ ${done.join(', ')}.` : '') +
          (pending.length ? ` ⏳ ${pending.join(', ')}.` : '') +
          (away.length ? ` 🏖️ ${away.join(', ')}.` : ''),
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
