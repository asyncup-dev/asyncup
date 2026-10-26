import { DateTime } from 'luxon';
import type { ChatAdapter } from './adapter.js';
import type { Mention } from './commands.js';
import { can, resolveAccess } from './permissions.js';
import type { Repo } from '../db/repo.js';
import {
  standupDays,
  WEEKDAYS,
  type AwayReason,
  type Participant,
  type Run,
  type ScheduleChannel,
  type ScheduleChange,
  type ScheduleOverride,
  type Standup,
  type Weekday,
} from './types.js';
import type { WebhookNotifier } from './webhooks.js';

/** Sentinel for a personal week with no fixed days — only dated "working" overrides count. */
export const ADHOC = 'adhoc';

const WEEKDAY_BY_LUXON: Record<number, Weekday> = { 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat', 7: 'sun' };
const LABEL: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const LONG: Record<string, Weekday> = {
  monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat', sunday: 'sun',
  mon: 'mon', tue: 'tue', tues: 'tue', wed: 'wed', weds: 'wed', thu: 'thu', thur: 'thu', thurs: 'thu', fri: 'fri', sat: 'sat', sun: 'sun',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "mon - thu" arrives as three tokens; fold a lone dash into the range it joins. */
function joinRanges(tokens: string[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    if (token === '-' && last !== undefined) out[out.length - 1] = `${last}-`;
    else if (last !== undefined && last.endsWith('-')) out[out.length - 1] = `${last}${token}`;
    else out.push(token);
  }
  return out;
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAY_BY_LUXON[DateTime.fromISO(date).weekday]!;
}

/**
 * "mon-thu", "mon,tue,wed", "weekdays", "adhoc", "reset" → the stored value
 * (null = follow the standup) or a message saying what was wrong.
 */
export function parseWorkingDays(value: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const v = value.trim().toLowerCase();
  if (['reset', 'standup', 'default', 'follow'].includes(v)) return { ok: true, value: null };
  if (['adhoc', 'ad-hoc'].includes(v)) return { ok: true, value: ADHOC };
  if (v === 'weekdays') return { ok: true, value: 'mon,tue,wed,thu,fri' };
  const picked = new Set<Weekday>();
  for (const token of joinRanges(v.split(/[\s,]+/).filter(Boolean))) {
    const [from, to] = token.split('-');
    const a = LONG[from!];
    const b = to === undefined ? a : LONG[to];
    if (!a || !b) return { ok: false, message: `"${token}" isn't a day — use names like \`mon-thu\`, \`mon,wed,fri\`, \`adhoc\` or \`reset\`.` };
    const ai = WEEKDAYS.indexOf(a);
    const bi = WEEKDAYS.indexOf(b);
    if (bi < ai) return { ok: false, message: `"${token}" runs backwards — put the earlier day first.` };
    for (let i = ai; i <= bi; i++) picked.add(WEEKDAYS[i]!);
  }
  if (picked.size === 0) return { ok: false, message: 'Say which days, e.g. `days mon-thu`, `days adhoc` or `days reset`.' };
  return { ok: true, value: WEEKDAYS.filter((d) => picked.has(d)).join(',') };
}

/** "Follows the standup", "Ad hoc", "Mon–Thu", "Mon–Wed, Fri". */
export function describeWorkingDays(workingDays: string | null): string {
  if (workingDays === null) return 'Follows the standup';
  if (workingDays === ADHOC) return 'Ad hoc';
  const days = workingDays.split(',') as Weekday[];
  const runs: string[] = [];
  let start = 0;
  for (let i = 1; i <= days.length; i++) {
    const contiguous = i < days.length && WEEKDAYS.indexOf(days[i]!) === WEEKDAYS.indexOf(days[i - 1]!) + 1;
    if (contiguous) continue;
    const a = days[start]!;
    const b = days[i - 1]!;
    runs.push(a === b ? LABEL[a] : i - 1 - start === 1 ? `${LABEL[a]}, ${LABEL[b]}` : `${LABEL[a]}–${LABEL[b]}`);
    start = i;
  }
  return runs.join(', ');
}

export type DayStatus = { expected: true } | { expected: false; reason: AwayReason };

/**
 * Whether a person is expected on a date. A dated override wins, then
 * vacation, then their own days on the standup, else the standup's days.
 */
export function dayStatus(
  participant: Pick<Participant, 'onVacation' | 'workingDays'>,
  date: string,
  override: ScheduleOverride | null | undefined,
  standupDays: readonly string[],
): DayStatus {
  if (override?.status === 'active') return override.working ? { expected: true } : { expected: false, reason: 'day_off' };
  if (participant.onVacation) return { expected: false, reason: 'vacation' };
  if (participant.workingDays === ADHOC) return { expected: false, reason: 'off_day' };
  const week = participant.workingDays === null ? standupDays : participant.workingDays.split(',');
  return week.includes(weekdayOf(date)) ? { expected: true } : { expected: false, reason: 'off_day' };
}

/** "Mon–Fri": the standup's own days, as people read them. */
export function standupDaysLabel(standup: Standup): string {
  return describeWorkingDays(standupDays(standup).join(','));
}

export const AWAY_LABEL: Record<AwayReason, string> = {
  vacation: 'Vacation',
  calendar_ooo: 'Calendar out of office',
  day_off: 'Day off',
  off_day: 'Not a working day',
  skipped: 'Skipped',
};

/** Reads one date at tokens[i]: today, tomorrow, a weekday, 19-sep / 19 sep [2026], sep 19, or 2026-09-19. */
function takeDate(tokens: string[], i: number, today: DateTime): { date: DateTime; consumed: number } | null {
  const t = tokens[i];
  if (!t) return null;
  if (t === 'today') return { date: today, consumed: 1 };
  if (t === 'tomorrow') return { date: today.plus({ days: 1 }), consumed: 1 };
  if (LONG[t]) {
    const want = WEEKDAYS.indexOf(LONG[t]!) + 1;
    const delta = (want - today.weekday + 7) % 7;
    return { date: today.plus({ days: delta }), consumed: 1 };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const d = DateTime.fromISO(t, { zone: today.zone });
    return d.isValid ? { date: d, consumed: 1 } : null;
  }
  const dayMonth = (dayTok: string | undefined, monTok: string | undefined) => {
    if (!dayTok || !monTok) return null;
    const day = Number(dayTok.replace(/(st|nd|rd|th)$/, ''));
    const month = MONTHS.indexOf(monTok.slice(0, 3));
    if (!Number.isInteger(day) || day < 1 || day > 31 || month < 0) return null;
    return { day, month: month + 1 };
  };
  let dm = dayMonth(t, tokens[i + 1]);
  let consumed = 2;
  if (!dm) {
    dm = dayMonth(tokens[i + 1], t);
    consumed = 2;
  }
  if (!dm && t.includes('-')) {
    const [a, b] = t.split('-');
    dm = dayMonth(a, b) ?? dayMonth(b, a);
    consumed = 1;
  }
  if (!dm) return null;
  const yearTok = tokens[i + consumed];
  const explicitYear = !!yearTok && /^\d{4}$/.test(yearTok);
  if (explicitYear) consumed += 1;
  const d = DateTime.fromObject({ year: explicitYear ? Number(yearTok) : today.year, month: dm.month, day: dm.day }, { zone: today.zone });
  if (!d.isValid) return null;
  return { date: explicitYear ? d : nearestYear(d, today), consumed };
}

/**
 * Without a year, a date more than three months back means next year: "2 jan"
 * said in December is next January, while "1 sep" in mid-September is a recent day.
 */
function nearestYear(d: DateTime, today: DateTime): DateTime {
  return d < today.minus({ months: 3 }) ? d.plus({ years: 1 }) : d;
}

/** A real calendar date in YYYY-MM-DD form (2026-02-30 is not). */
export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid;
}

/**
 * Dates from free text: "today", "tomorrow", "fri", "19 sep", "2026-09-19",
 * and ranges joined by "to", "-", "–" or "until". Whatever follows is the reason.
 */
export function parseDateSpec(text: string, now: DateTime): { ok: true; dates: string[]; rest: string } | { ok: false; message: string } {
  const today = now.startOf('day');
  const raw = text.trim().split(/\s+/).filter(Boolean);
  const tokens = raw.map((t) => t.toLowerCase());
  const first = takeDate(tokens, 0, today);
  if (!first) return { ok: false, message: 'Say when, e.g. `today`, `tomorrow`, `fri`, `19 sep` or `22 sep to 24 sep`, then an optional reason.' };
  let i = first.consumed;
  let end = first.date;
  const joiner = tokens[i];
  if (joiner && ['to', '-', '–', '—', 'until', 'through', 'till'].includes(joiner)) {
    // The end of a range is read relative to its start, so "mon until wed" is one working week.
    const second = takeDate(tokens, i + 1, first.date);
    if (!second) return { ok: false, message: `I couldn't read the end of that range after "${joiner}".` };
    end = second.date;
    i += 1 + second.consumed;
  }
  if (end < first.date) return { ok: false, message: 'That range ends before it starts.' };
  const span = Math.round(end.diff(first.date, 'days').days) + 1;
  if (span > 31) return { ok: false, message: 'Ranges are capped at 31 days — for longer absences use `vacation`.' };
  const dates: string[] = [];
  for (let k = 0; k < span; k++) dates.push(first.date.plus({ days: k }).toISODate()!);
  return { ok: true, dates, rest: raw.slice(i).join(' ').trim() };
}

/** "Fri 19 Sep" or "Mon 22 – Wed 24 Sep". */
export function describeDates(dates: string[]): string {
  const fmt = (d: string) => DateTime.fromISO(d).toFormat('ccc d LLL');
  if (dates.length === 1) return fmt(dates[0]!);
  return `${fmt(dates[0]!)} – ${fmt(dates[dates.length - 1]!)}`;
}

/** Who is changing a schedule; whether they manage the person is worked out from the rosters. */
export interface Actor extends Mention {
  /** A workspace admin or the operator: manages everyone. */
  admin: boolean;
}

export interface OverrideRequest {
  target: Mention;
  dates: string[];
  working: boolean;
  reason: string;
  actor: Actor;
  channel: ScheduleChannel;
}

export type ScheduleResult = { ok: true; message: string; status: 'active' | 'pending' } | { ok: false; message: string };

/** What a manager sees on the approval card / list. */
export interface TimeOffRequest {
  ids: number[];
  person: Mention;
  dates: string[];
  working: boolean;
  reason: string;
  standup: Standup;
}

/**
 * Which standups' time-off policies bind a change. A manager changing someone
 * else's schedule is bound by none; a person changing their own is bound by
 * every standup they are on and don't administer.
 */
type Authority = { ok: true; self: boolean; governed: Standup[] } | { ok: false; message: string };

/**
 * Personal weeks and dated overrides, with the standup's time-off policy
 * applied: self-service (managers get a digest), approval (a manager must
 * say yes before it counts), or managers only. Managers override in any mode.
 */
export class ScheduleService {
  constructor(
    private repo: Repo,
    private adapter: ChatAdapter,
    private now: () => DateTime = () => DateTime.utc(),
    private webhooks: WebhookNotifier | null = null,
    private log: (msg: string) => void = () => {},
    private leaveShown: () => Promise<boolean> = async () => false,
  ) {}

  /** The line telling people their Chat status and calendar will show days off, when that is on. */
  private async leaveLine(working: boolean, whose: 'Your' | 'Their'): Promise<string> {
    return !working && (await this.leaveShown()) ? ` ${whose} Chat status and calendar will show it.` : '';
  }

  private async authority(target: Mention, actor: Actor, standups: Standup[]): Promise<Authority> {
    const self = actor.userName === target.userName;
    if (actor.admin) return { ok: true, self, governed: [] };
    const access = standups.length ? await resolveAccess(this.repo, { tenantId: standups[0]!.tenantId, userName: actor.userName }, false) : null;
    const administered = new Set(standups.filter((s) => can(access!, 'schedules.manage', s.id)).map((s) => s.id));
    if (!self) {
      return administered.size > 0 ? { ok: true, self, governed: [] } : { ok: false, message: `Only ${target.displayName}'s managers can change their schedule.` };
    }
    return { ok: true, self, governed: standups.filter((s) => !administered.has(s.id)) };
  }

  /**
   * Sets a person's days on one standup. Without a standup, someone on one
   * standup sets that one and someone on several is asked which; `all` is the
   * deprecated form that sets every standup at once.
   */
  async setWorkingDays(target: Mention, value: string, actor: Actor, channel: ScheduleChannel, scope?: number | 'all'): Promise<ScheduleResult> {
    const parsed = parseWorkingDays(value);
    if (!parsed.ok) return parsed;
    const standups = await this.repo.listStandupsForUser(target.userName);
    if (standups.length === 0) return { ok: false, message: notOnRoster(target, actor) };
    if (scope === 'all') return this.setEveryWeek(target, parsed.value, actor, channel, standups);
    if (scope === undefined && standups.length > 1) {
      const lines = standups.map((s) => `\`days #${s.id} ${value.trim()}\` for ${s.name}`);
      return { ok: false, message: `Which standup? Reply with one of these:\n${lines.join('\n')}` };
    }
    const standup = scope === undefined ? standups[0]! : standups.find((s) => s.id === scope);
    const self = actor.userName === target.userName;
    if (!standup) return { ok: false, message: self ? 'You’re not on that standup.' : `${target.displayName} isn’t on that standup.` };
    const manages = actor.admin || can(await resolveAccess(this.repo, { tenantId: standup.tenantId, userName: actor.userName }, false), 'schedules.manage', standup.id);
    if (!self && !manages) return { ok: false, message: `Only the managers of *${standup.name}* can change ${target.displayName}'s days there.` };
    // Days have no request flow, so under approval they are the managers' call too.
    if (self && !manages && standup.timeOffPolicy !== 'self') {
      return { ok: false, message: `Only your managers can change your days on *${standup.name}* — ask them, or DM them the days you need.` };
    }
    await this.repo.setWorkingDays(standup.id, target.userName, parsed.value);
    const days = describeWorkingDays(parsed.value);
    const summary = parsed.value === null ? `${target.displayName} now follows ${standup.name}'s days` : `${target.displayName}'s days on ${standup.name} are now ${days}`;
    await this.recordChange(target, summary, actor, self, channel, [standup], standups);
    await this.applyToRuns(target.userName, [this.today(standup)], true, [standup]);
    if (!self) {
      const tag = standups.length > 1 ? `#${standup.id} ` : '';
      const told = parsed.value === null ? `put you back on *${standup.name}*’s days (*${standupDaysLabel(standup)}*)` : `set your days on *${standup.name}* to *${days}*`;
      await this.dm(target.userName, `📅 ${actor.displayName} ${told}.${parsed.value === null ? '' : ` Reply \`days ${tag}reset\` to follow the standup again.`}`);
    }
    const adhoc = parsed.value === ADHOC ? ' Mark working days with `working <date>`.' : '';
    if (parsed.value === null) return { ok: true, status: 'active', message: `✅ ${self ? 'You now follow' : `${target.displayName} now follows`} *${standup.name}*’s days (*${standupDaysLabel(standup)}*).` };
    return { ok: true, status: 'active', message: `✅ ${self ? 'Your' : `${target.displayName}'s`} days on *${standup.name}* are now *${days}*.${adhoc}` };
  }

  /** The deprecated all-standups form, kept for existing API and MCP callers. */
  private async setEveryWeek(target: Mention, value: string | null, actor: Actor, channel: ScheduleChannel, standups: Standup[]): Promise<ScheduleResult> {
    const auth = await this.authority(target, actor, standups);
    if (!auth.ok) return auth;
    // A week has no request flow, so under approval it is the managers' call too.
    if (auth.governed.some((s) => s.timeOffPolicy !== 'self')) {
      return { ok: false, message: 'Only your managers can change your week here — ask them, or DM them the days you need.' };
    }
    await this.repo.setWorkingDaysForUser(target.userName, value);
    const summary = `${target.displayName}'s week is now ${describeWorkingDays(value)}`;
    await this.recordChange(target, summary, actor, auth.self, channel, standups, standups);
    for (const standup of standups) await this.applyToRuns(target.userName, [this.today(standup)], true, [standup]);
    if (!auth.self) {
      await this.dm(target.userName, `📅 ${actor.displayName} set your week to *${describeWorkingDays(value)}* on every standup you’re on.`);
    }
    const who = auth.self ? 'Your' : `${target.displayName}'s`;
    return { ok: true, status: 'active', message: `✅ ${who} week is now *${describeWorkingDays(value)}* across ${plural(standups.length, 'standup')}.${value === ADHOC ? ' Mark working days with `working <date>`.' : ''}` };
  }

  async setOverride(input: OverrideRequest): Promise<ScheduleResult> {
    const { target, working, reason, actor, channel } = input;
    const standups = await this.repo.listStandupsForUser(target.userName);
    if (standups.length === 0) return { ok: false, message: notOnRoster(target, actor) };
    const auth = await this.authority(target, actor, standups);
    if (!auth.ok) return auth;
    const { self, governed } = auth;
    const today = this.today(standups[0]!);
    if (governed.some((s) => s.timeOffPolicy === 'managers')) {
      return { ok: false, message: 'Only your managers can mark you away here — ask them, or DM them the dates.' };
    }
    if (governed.length > 0 && input.dates.some((d) => d < today)) {
      return { ok: false, message: 'Past days can only be changed by a manager.' };
    }
    const approvers = governed.filter((s) => s.timeOffPolicy === 'approval');
    let dates = input.dates;
    if (approvers.length > 0) {
      // An approved day stays approved: repeating it only updates the reason, changing it needs a manager.
      const kept: string[] = [];
      for (const date of dates) {
        const existing = await this.repo.getOverride(target.userName, date);
        if (existing?.status !== 'active') continue;
        if (existing.working !== working) {
          return { ok: false, message: `${describeDates([date])} is already set as ${existing.working ? 'working' : 'off'} — ask your managers to change it.` };
        }
        kept.push(date);
      }
      for (const date of kept) await this.save(target, date, working, reason, 'active', actor, channel);
      dates = dates.filter((d) => !kept.includes(d));
      if (dates.length === 0) return { ok: true, status: 'active', message: `✅ ${describeDates(input.dates)} was already approved — reason updated.` };
    }
    const status = approvers.length > 0 ? 'pending' : 'active';
    const saved: ScheduleOverride[] = [];
    for (const date of dates) saved.push(await this.save(target, date, working, reason, status, actor, channel));
    const what = `${working ? 'working' : 'off'} ${describeDates(dates)}${reason ? ` (${reason})` : ''}`;
    if (status === 'pending') {
      const request: Omit<TimeOffRequest, 'standup'> = { ids: saved.map((o) => o.id), person: target, dates, working, reason };
      const told = new Set<string>();
      for (const standup of approvers) {
        await this.webhooks?.timeOffRequest(standup, request);
        for (const admin of await this.repo.listAdmins(standup.id)) {
          if (told.has(admin.userName)) continue;
          told.add(admin.userName);
          try {
            await this.adapter.sendTimeOffRequest(admin.userName, { ...request, standup });
          } catch (err) {
            this.log(`time-off request to ${admin.userName} failed: ${err}`);
          }
        }
        // An off-day request also reaches the person's reporting manager on this standup.
        if (!working) {
          const rm = await this.repo.getReportingManager(standup.id, target.userName);
          if (rm && rm.userName !== target.userName && !told.has(rm.userName)) {
            told.add(rm.userName);
            try {
              await this.adapter.sendTimeOffRequest(rm.userName, { ...request, standup });
            } catch (err) {
              this.log(`time-off request to ${rm.userName} failed: ${err}`);
            }
          }
        }
      }
      const names = [...new Set(approvers.map((s) => s.name))].join(', ');
      return { ok: true, status, message: `📨 Sent to the managers of ${names} for approval — you'll hear back here. Withdraw with \`off cancel ${dates[0]}\`.` };
    }
    await this.recordChange(target, `${target.displayName} is ${what}`, actor, self, channel, standups, standups);
    await this.applyToRuns(target.userName, dates);
    if (!self) {
      await this.dm(
        target.userName,
        working
          ? `📅 ${actor.displayName} marked you *working* on ${describeDates(dates)}${reason ? ` (${reason})` : ''} — you'll be prompted as usual.`
          : `🏖️ ${actor.displayName} marked you *away* on ${describeDates(dates)}${reason ? ` (${reason})` : ''} — no prompt, and you won't be counted as missing. If that's wrong, reply \`working ${dates[0]}\`.${await this.leaveLine(working, 'Your')}`,
      );
    }
    const affected = standups.map((s) => s.name).join(', ');
    return {
      ok: true,
      status,
      message: working
        ? `✅ ${self ? 'You are' : `${target.displayName} is`} marked *working* on ${describeDates(dates)} for ${affected}.`
        : `🏖️ ${describeDates(dates)} marked off${reason ? ` (${reason})` : ''} for ${affected} — no prompt, not counted as missing.${governed.length > 0 ? ' Your managers get today’s digest.' : ''} Undo with \`off cancel ${dates[0]}\`.${await this.leaveLine(working, self ? 'Your' : 'Their')}`,
    };
  }

  private save(target: Mention, date: string, working: boolean, reason: string, status: 'active' | 'pending', actor: Actor, channel: ScheduleChannel): Promise<ScheduleOverride> {
    return this.repo.upsertOverride({
      userName: target.userName,
      displayName: target.displayName,
      date,
      working,
      reason,
      status,
      setByUserName: actor.userName,
      setByDisplayName: actor.displayName,
      channel,
      at: this.now().toISO()!,
    });
  }

  /**
   * Withdraws an override. Managers can withdraw anyone's; a person can always
   * withdraw a pending request, and otherwise only what their policy would
   * let them set: no past days, and no dropping a working day outside self-service.
   */
  async cancelOverride(target: Mention, date: string, actor: Actor): Promise<ScheduleResult> {
    const existing = await this.repo.getOverride(target.userName, date);
    if (!existing || (existing.status !== 'active' && existing.status !== 'pending')) return { ok: false, message: `Nothing is set for ${describeDates([date])}.` };
    const standups = await this.repo.listStandupsForUser(target.userName);
    const auth = await this.authority(target, actor, standups);
    if (!auth.ok) return auth;
    if (auth.governed.length > 0 && existing.status === 'active') {
      if (date < this.today(auth.governed[0]!)) return { ok: false, message: 'Past days can only be changed by a manager.' };
      if (existing.working && auth.governed.some((s) => s.timeOffPolicy !== 'self')) {
        return { ok: false, message: 'Only your managers can drop a working day here — ask them.' };
      }
    }
    const wasActive = existing.status === 'active';
    await this.repo.setOverrideStatus(existing.id, 'withdrawn', this.now().toISO()!);
    if (wasActive) {
      await this.applyToRuns(target.userName, [date]);
      await this.recordChange(target, `${target.displayName} cancelled ${existing.working ? 'working' : 'off'} ${describeDates([date])}`, actor, auth.self, 'chat', standups, standups);
    }
    return { ok: true, status: 'active', message: `✅ ${describeDates([date])} is back to ${auth.self ? 'your' : `${target.displayName}'s`} usual week.` };
  }

  /** Overrides from today on, every status, for the "off list" view. */
  async listUpcoming(userName: string, zone: string): Promise<ScheduleOverride[]> {
    return this.repo.listOverridesForUser(userName, this.now().setZone(zone).toISODate()!);
  }

  /** A manager approves or declines one person's pending request (all ids in the batch share one decision). */
  async decide(ids: number[], approve: boolean, actor: Actor, note: string | null): Promise<ScheduleResult> {
    const overrides = (await Promise.all(ids.map((id) => this.repo.getOverrideById(id)))).filter((o): o is ScheduleOverride => !!o);
    const pending = overrides.filter((o) => o.status === 'pending');
    if (pending.length === 0) return { ok: false, message: 'That request was already decided or withdrawn.' };
    if (new Set(pending.map((o) => o.userName)).size > 1) return { ok: false, message: 'Decide one person’s request at a time.' };
    const person = { userName: pending[0]!.userName, displayName: pending[0]!.displayName };
    const standups = await this.repo.listStandupsForUser(person.userName);
    const working = pending[0]!.working;
    if (!actor.admin) {
      if (person.userName === actor.userName) return { ok: false, message: 'Your own requests go to your managers.' };
      const access = standups.length ? await resolveAccess(this.repo, { tenantId: standups[0]!.tenantId, userName: actor.userName }, false) : null;
      const manages = !!access && standups.some((s) => can(access, 'schedules.manage', s.id));
      // A reporting manager can decide a report's day off, even without managing the standup.
      const reportsToActor = !working && (await this.repo.isReportingManagerOf(actor.userName, person.userName));
      if (!manages && !reportsToActor) return { ok: false, message: `Only ${person.displayName}'s managers can decide this.` };
    }
    const at = this.now().toISO()!;
    for (const o of pending) await this.repo.setOverrideStatus(o.id, approve ? 'active' : 'declined', at, { byDisplayName: actor.displayName, note });
    const dates = pending.map((o) => o.date).sort();
    if (approve) await this.applyToRuns(person.userName, dates);
    for (const standup of standups) await this.webhooks?.scheduleChange(standup, { person, summary: `${approve ? 'approved' : 'declined'}: ${working ? 'working' : 'off'} ${describeDates(dates)}`, by: actor.displayName, channel: 'chat' });
    await this.dm(
      person.userName,
      approve
        ? `✅ ${actor.displayName} approved your ${working ? 'working' : 'time off'} request for ${describeDates(dates)}.${note ? ` “${note}”` : ''}${await this.leaveLine(working, 'Your')}`
        : `❌ ${actor.displayName} declined your ${working ? 'working' : 'time off'} request for ${describeDates(dates)}.${note ? ` “${note}”` : ''} Talk to them if you need those days.`,
    );
    return { ok: true, status: 'active', message: `${approve ? '✅ Approved' : '❌ Declined'} — ${person.displayName} has been told.${approve ? await this.leaveLine(working, 'Their') : ''}` };
  }

  /**
   * When a run opens: people whose days or overrides exclude the date start it
   * as away. `run now` counts the day as one of the standup's own.
   */
  async applyToNewRun(standup: Standup, run: Run, asStandupDay = false): Promise<void> {
    const overrides = await this.repo.listActiveOverridesOn(run.date);
    const days = asStandupDay ? [...standupDays(standup), weekdayOf(run.date)] : standupDays(standup);
    for (const p of await this.repo.listParticipants(standup.id)) {
      const status = dayStatus(p, run.date, overrides.get(p.userName), days);
      if (!status.expected && status.reason !== 'vacation') await this.repo.setRunAway(run.id, p.userName, status.reason);
      if (status.expected && p.onVacation) await this.repo.setRunAway(run.id, p.userName, null);
    }
  }

  /**
   * At run close: lapse this roster's requests that were waiting on this
   * standup's deadline (or are simply past), then send its managers the
   * self-service changes they haven't seen yet.
   */
  async onRunClosed(standup: Standup, run: Run): Promise<void> {
    const at = this.now().toISO()!;
    const names = (await this.repo.listParticipants(standup.id)).map((p) => p.userName);
    const lapseUpTo = standup.timeOffPolicy === 'approval' ? run.date : DateTime.fromISO(run.date).minus({ days: 1 }).toISODate()!;
    for (const o of await this.repo.expirePendingOverrides(names, lapseUpTo, at)) {
      await this.dm(o.userName, `⌛ Your ${o.working ? 'working' : 'time off'} request for ${describeDates([o.date])} wasn't answered before the deadline, so it lapsed — you were counted as expected.`);
    }
    const changes = await this.repo.listUndigestedChanges(standup.id, names, this.now().minus({ days: 7 }).toISO()!);
    if (changes.length === 0) return;
    const text = digestText(standup, changes);
    for (const admin of await this.repo.listAdmins(standup.id)) {
      try {
        await this.adapter.sendDm(admin.userName, text);
      } catch (err) {
        this.log(`schedule digest to ${admin.userName} failed: ${err}`);
      }
    }
    await this.repo.markChangesDigested(standup.id, changes.map((c) => c.id), at);
  }

  /**
   * Re-evaluates the person's runs on these dates after a schedule change.
   * Only schedule-driven reasons move, and a closed run keeps anyone who submitted.
   */
  async applyToRuns(userName: string, dates: string[], openOnly = false, only?: Standup[]): Promise<void> {
    const standups = only ?? (await this.repo.listStandupsForUser(userName));
    for (const date of dates) {
      const override = await this.repo.getOverride(userName, date);
      for (const standup of standups) {
        const run = await this.repo.getRun(standup.id, date);
        if (!run || (openOnly && run.status !== 'open')) continue;
        const participant = (await this.repo.listParticipants(standup.id)).find((p) => p.userName === userName);
        const rp = (await this.repo.listRunParticipants(run.id)).find((p) => p.userName === userName);
        if (!participant || !rp) continue;
        if (run.status !== 'open' && (await this.repo.getSubmission(run.id, userName))) continue;
        const status = dayStatus(participant, date, override, standupDays(standup));
        const movable = rp.awayReason === null || rp.awayReason === 'day_off' || rp.awayReason === 'off_day';
        if (!status.expected && movable && rp.awayReason !== status.reason) await this.repo.setRunAway(run.id, userName, status.reason);
        if (status.expected && rp.awayReason !== null && movable) await this.repo.setRunAway(run.id, userName, null);
      }
    }
  }

  /** The service clock in a zone — chat handlers parse relative dates against it. */
  nowIn(zone: string): DateTime {
    return this.now().setZone(zone);
  }

  private today(standup: Standup): string {
    return this.now().setZone(standup.timezone).toISODate()!;
  }

  /** Logs a self-service change for the managers' digest of the standups it affects, and sends their webhooks. */
  private async recordChange(target: Mention, summary: string, actor: Actor, self: boolean, channel: ScheduleChannel, affected: Standup[], all: Standup[]): Promise<void> {
    if (self) {
      const at = this.now().toISO()!;
      const id = await this.repo.logScheduleChange({ userName: target.userName, displayName: target.displayName, summary, byDisplayName: actor.displayName, channel, at });
      // The other standups' managers have nothing to review.
      for (const standup of all) if (!affected.some((s) => s.id === standup.id)) await this.repo.markChangesDigested(standup.id, [id], at);
    }
    for (const standup of affected) await this.webhooks?.scheduleChange(standup, { person: target, summary, by: actor.displayName, channel });
  }

  private async dm(userName: string, text: string): Promise<void> {
    try {
      await this.adapter.sendDm(userName, text);
    } catch (err) {
      this.log(`schedule DM to ${userName} failed: ${err}`);
    }
  }
}

function notOnRoster(target: Mention, actor: Actor): string {
  return actor.userName === target.userName ? "You're not on any standup roster yet." : `${target.displayName} isn't on any standup roster.`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The managers' once-a-day summary of self-service changes. */
export function digestText(standup: Standup, changes: ScheduleChange[]): string {
  const lines = changes.map((c) => `• ${c.summary} — via ${c.channel}`);
  return `📅 Schedule changes for *${standup.name}* (${plural(changes.length, 'change')}):\n${lines.join('\n')}\nReview or undo under Team in the console.`;
}
