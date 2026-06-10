import { DateTime, IANAZone } from 'luxon';
import type { Repo } from '../db/repo.js';
import { WEEKDAYS, type Standup, type Weekday } from './types.js';

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
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const HELP = `*Standup bot commands* (mention me in this space):
\`setup [name]\` — create a standup reporting to this space
\`add @user…\` — add participants (mandatory by default)
\`remove @user…\` — remove participants
\`mandatory @user…\` / \`optional @user…\` — toggle whether someone counts toward the report
\`time HH:MM\` — when the prompt DM goes out (participant's local time)
\`deadline HH:MM\` — when the run closes and the report posts (standup timezone)
\`remind <minutes>\` — reminder nudge this many minutes before the deadline
\`timezone <IANA zone>\` — e.g. Asia/Kolkata
\`days mon,tue,wed,thu,fri\` — which days the standup runs
\`status\` — current config and today's progress`;

export class CommandHandler {
  constructor(
    private repo: Repo,
    private defaultTimezone: string,
    private now: () => DateTime = () => DateTime.utc(),
  ) {}

  handle(ctx: CommandContext): string {
    const [verb = '', ...rest] = ctx.text.trim().split(/\s+/);
    const arg = rest.join(' ').trim();

    if (verb === '' || verb.toLowerCase() === 'help') return HELP;

    const command = verb.toLowerCase();
    if (command === 'setup') return this.setup(ctx, arg);

    const standup = this.repo.getStandupBySpace(ctx.tenantId, ctx.spaceName);
    if (!standup) {
      return 'No standup is configured for this space yet. Run `setup` first.';
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
      case 'status':
        return this.status(standup);
      default:
        return `Unknown command \`${verb}\`. Try \`help\`.`;
    }
  }

  private setup(ctx: CommandContext, name: string): string {
    if (this.repo.getStandupBySpace(ctx.tenantId, ctx.spaceName)) {
      return 'A standup already exists for this space. Use `status` to see its configuration.';
    }
    const standup = this.repo.createStandup({
      tenantId: ctx.tenantId,
      spaceName: ctx.spaceName,
      name: name || 'Daily Standup',
      timezone: this.defaultTimezone,
    });
    return (
      `✅ Standup *${standup.name}* created. Reports will post in this space.\n` +
      `Defaults: prompt ${standup.promptTime}, deadline ${standup.deadlineTime}, ` +
      `reminder ${standup.reminderMinutesBefore}m before, ${standup.timezone}, ${standup.days}.\n` +
      `Next: \`add @user…\` to add participants.`
    );
  }

  private addParticipants(standup: Standup, mentions: Mention[]): string {
    if (mentions.length === 0) return 'Mention the people to add, e.g. `add @Asha @Rohit`.';
    for (const m of mentions) {
      this.repo.upsertParticipant({
        standupId: standup.id,
        userName: m.userName,
        displayName: m.displayName,
      });
    }
    return `✅ Added ${mentions.map((m) => m.displayName).join(', ')} (mandatory). Use \`optional @user\` to exclude someone from the report count.`;
  }

  private removeParticipants(standup: Standup, mentions: Mention[]): string {
    if (mentions.length === 0) return 'Mention the people to remove, e.g. `remove @Asha`.';
    const removed: string[] = [];
    const unknown: string[] = [];
    for (const m of mentions) {
      (this.repo.removeParticipant(standup.id, m.userName) ? removed : unknown).push(m.displayName);
    }
    const parts: string[] = [];
    if (removed.length) parts.push(`✅ Removed ${removed.join(', ')}.`);
    if (unknown.length) parts.push(`⚠️ Not participants: ${unknown.join(', ')}.`);
    return parts.join(' ');
  }

  private setMandatory(standup: Standup, mentions: Mention[], mandatory: boolean): string {
    if (mentions.length === 0) {
      return `Mention the people to mark as ${mandatory ? 'mandatory' : 'optional'}.`;
    }
    const changed: string[] = [];
    const unknown: string[] = [];
    for (const m of mentions) {
      (this.repo.setParticipantMandatory(standup.id, m.userName, mandatory) ? changed : unknown).push(
        m.displayName,
      );
    }
    const parts: string[] = [];
    if (changed.length) parts.push(`✅ ${changed.join(', ')} now ${mandatory ? 'mandatory' : 'optional'}.`);
    if (unknown.length) parts.push(`⚠️ Not participants: ${unknown.join(', ')}. Use \`add\` first.`);
    return parts.join(' ');
  }

  private setTime(standup: Standup, value: string, field: 'promptTime' | 'deadlineTime'): string {
    if (!TIME_RE.test(value)) return 'Please give a 24h time like `09:30`.';
    const next = { promptTime: standup.promptTime, deadlineTime: standup.deadlineTime, [field]: value };
    if (next.promptTime >= next.deadlineTime) {
      return `⚠️ Prompt time (${next.promptTime}) must be before the deadline (${next.deadlineTime}).`;
    }
    this.repo.updateStandup(standup.id, { [field]: value });
    return field === 'promptTime'
      ? `✅ Prompts will go out at ${value} (each participant's local time).`
      : `✅ Deadline set to ${value} ${standup.timezone}. The report posts then.`;
  }

  private setReminder(standup: Standup, value: string): string {
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
      return 'Please give the number of minutes before the deadline, e.g. `remind 60`. Use `remind 0` to disable.';
    }
    this.repo.updateStandup(standup.id, { reminderMinutesBefore: minutes });
    return minutes === 0
      ? '✅ Reminder disabled.'
      : `✅ Reminder will go out ${minutes} minutes before the deadline.`;
  }

  private setTimezone(standup: Standup, value: string): string {
    if (!value || !IANAZone.isValidZone(value)) {
      return 'Please give a valid IANA timezone, e.g. `timezone Asia/Kolkata`.';
    }
    this.repo.updateStandup(standup.id, { timezone: value });
    return `✅ Timezone set to ${value}.`;
  }

  private setDays(standup: Standup, value: string): string {
    const days = value
      .toLowerCase()
      .split(/[,\s]+/)
      .filter(Boolean) as Weekday[];
    const invalid = days.filter((d) => !WEEKDAYS.includes(d));
    if (days.length === 0 || invalid.length > 0) {
      return 'Please list days like `days mon,tue,wed,thu,fri`.';
    }
    const ordered = WEEKDAYS.filter((d) => days.includes(d));
    this.repo.updateStandup(standup.id, { days: ordered.join(',') });
    return `✅ Standup runs on: ${ordered.join(', ')}.`;
  }

  private status(standup: Standup): string {
    const participants = this.repo.listParticipants(standup.id);
    const lines = [
      `*${standup.name}*`,
      `Prompt ${standup.promptTime} (participant local) · deadline ${standup.deadlineTime} ${standup.timezone} · reminder ${standup.reminderMinutesBefore}m before · ${standup.days}`,
      participants.length
        ? `Participants: ${participants
            .map((p) => `${p.displayName}${p.mandatory ? '' : ' (optional)'}`)
            .join(', ')}`
        : 'Participants: none yet — use `add @user`.',
    ];

    const today = this.now().setZone(standup.timezone).toISODate()!;
    const run = this.repo.getRun(standup.id, today);
    if (run) {
      const submitted = new Set(this.repo.listSubmissions(run.id).map((s) => s.userName));
      const roster = this.repo.listRunParticipants(run.id);
      const done = roster.filter((p) => submitted.has(p.userName)).map((p) => p.displayName);
      const pending = roster.filter((p) => !submitted.has(p.userName)).map((p) => p.displayName);
      lines.push(
        `Today (${run.date}, ${run.status}): ${done.length}/${roster.length} submitted.` +
          (done.length ? ` ✅ ${done.join(', ')}.` : '') +
          (pending.length ? ` ⏳ ${pending.join(', ')}.` : ''),
      );
    } else {
      lines.push(`No run yet today (${today}).`);
    }
    return lines.join('\n');
  }
}
