import { DateTime } from 'luxon';
import type { LeaveRow, PersonRow, Repo } from '../db/repo.js';
import type { SettingsService } from './settings.js';

export type DeclineMode = 'none' | 'new' | 'all';

/** An out-of-office event, midnight to midnight in the person's zone. */
export interface OooEvent {
  start: string;
  end: string;
  timeZone: string;
  decline: DeclineMode;
  message: string;
}

/** Writes to a person's Chat status and calendar, as that person. Errors carry a message fit to show an admin. */
export interface LeaveWriter {
  setStatus(email: string, status: { text: string; emoji: string; expireTime: string | null }): Promise<void>;
  /** Clears the custom status only while it still reads `text`. */
  clearStatus(email: string, text: string): Promise<void>;
  createOutOfOffice(email: string, event: OooEvent): Promise<string>;
  updateOutOfOffice(email: string, id: string, event: OooEvent): Promise<void>;
  deleteOutOfOffice(email: string, id: string): Promise<void>;
}

export const LEAVE_EMOJI = '🌴';
export const VACATION_TEXT = 'On leave';
const RETRY_MINUTES = 60;
const LOOKBACK_DAYS = 62;

const dayLabel = (date: string) => DateTime.fromISO(date).setLocale('en-GB').toFormat('ccc d LLL');
export const untilText = (end: string) => `On leave until ${dayLabel(end)}`;

/** Consecutive days off, bridging gaps made only of days the person doesn't work. */
export function leavePeriods(dates: string[], works: (date: string) => boolean): { start: string; end: string }[] {
  const periods: { start: string; end: string }[] = [];
  for (const date of [...new Set(dates)].sort()) {
    const last = periods[periods.length - 1];
    if (last) {
      let d = DateTime.fromISO(last.end).plus({ days: 1 });
      while (d.toISODate()! < date && !works(d.toISODate()!)) d = d.plus({ days: 1 });
      if (d.toISODate() === date) {
        last.end = date;
        continue;
      }
    }
    periods.push({ start: date, end: date });
  }
  return periods;
}

/**
 * Keeps each person's Chat custom status and Calendar out-of-office in step
 * with their leave in AsyncUp: dated days off and vacation mode. Leave is the
 * person's, not a standup's. Every sweep compares what should be shown with
 * what was written (leave_presence) and only calls Google for the difference,
 * so it is safe to run every tick. Failures wait an hour before a retry.
 */
export class LeavePresence {
  constructor(
    private repo: Repo,
    private settings: SettingsService,
    private writer: () => Promise<LeaveWriter | null>,
    private now: () => DateTime = () => DateTime.utc(),
    private log: (msg: string) => void = () => {},
  ) {}

  async sweep(): Promise<void> {
    const s = await this.settings.get();
    if (!s.leaveInChat) return;
    const from = this.now().minus({ days: LOOKBACK_DAYS }).toISODate()!;
    const daysOff = new Map<string, string[]>();
    for (const d of await this.repo.listDaysOffFrom(from)) daysOff.set(d.userName, [...(daysOff.get(d.userName) ?? []), d.date]);
    const vacation = new Set(await this.repo.listVacationUsers());
    const rows = await this.repo.listLeaveRows();
    const people = new Set([...daysOff.keys(), ...vacation, ...rows.map((r) => r.userName)]);
    const writer = await this.writer();
    const failures: string[] = [];
    for (const userName of people) {
      const mine = rows.filter((r) => r.userName === userName);
      const failure = await this.person(userName, daysOff.get(userName) ?? [], vacation.has(userName), mine, writer, s.leaveDeclineMode as DeclineMode);
      if (failure) failures.push(failure);
    }
    const still = (await this.repo.listLeaveRows()).some((r) => r.error);
    if (!still && s.leaveSyncError) await this.settings.update({ leaveSyncError: '', leaveSyncErrorAt: '' });
    if (failures.length) await this.settings.update({ leaveSyncError: failures[failures.length - 1]!, leaveSyncErrorAt: this.now().toUTC().toISO()! });
  }

  /** Brings one person in step; returns the last failure, if any. */
  private async person(userName: string, dates: string[], onVacation: boolean, rows: LeaveRow[], writer: LeaveWriter | null, decline: DeclineMode): Promise<string | null> {
    const people = await this.repo.listPersonRows(userName);
    const name = people[0]?.displayName ?? userName;
    const zone = people.find((p) => p.timezone)?.timezone ?? people[0]?.standupTimezone ?? (await this.settings.get()).defaultTimezone;
    const today = this.now().setZone(zone).toISODate()!;
    const works = (date: string) => people.length === 0 || people.some((p) => worksOn(p, date));
    const wanted = leavePeriods(dates, works).filter((p) => p.end >= today);

    // Periods that ended expire on their own; nothing to undo.
    let live = rows;
    for (const r of rows) {
      if (r.kind === 'dated' && !r.gone && r.endDate! < today) {
        await this.repo.deleteLeaveRow(r.id);
        live = live.filter((x) => x !== r);
      }
    }

    // Match each wanted period to an overlapping row, so a changed period moves its event rather than replacing it.
    const dated = live.filter((r) => r.kind === 'dated' && !r.gone);
    const matched = new Set<LeaveRow>();
    const plan: { row: LeaveRow; start: string; end: string; moved: boolean }[] = [];
    for (const p of wanted) {
      const hit = dated.find((r) => !matched.has(r) && r.startDate! <= p.end && r.endDate! >= p.start);
      if (hit) {
        matched.add(hit);
        plan.push({ row: hit, start: p.start, end: p.end, moved: hit.startDate !== p.start || hit.endDate !== p.end });
      } else {
        plan.push({ row: await this.repo.addLeaveRow({ userName, kind: 'dated', startDate: p.start, endDate: p.end }), start: p.start, end: p.end, moved: false });
      }
    }
    for (const r of dated) if (!matched.has(r)) await this.retire(r);
    let vacationRow = live.find((r) => r.kind === 'vacation' && !r.gone) ?? null;
    if (vacationRow && !onVacation) {
      await this.retire(vacationRow);
      vacationRow = null;
    }
    if (!vacationRow && onVacation) vacationRow = await this.repo.addLeaveRow({ userName, kind: 'vacation', startDate: null, endDate: null });

    const email = await this.repo.getUserEmail(userName);
    let failure: string | null = null;
    const attempt = async (row: LeaveRow, what: string, op: (w: LeaveWriter, email: string) => Promise<Partial<LeaveRow>>) => {
      if (row.errorAt && this.now().diff(DateTime.fromISO(row.errorAt), 'minutes').minutes < RETRY_MINUTES) return;
      try {
        if (!writer) throw new Error('it needs the service-account key under Settings › Google Chat.');
        if (!email) throw new Error('AsyncUp doesn’t know their email yet. It comes from the Directory, or from their first message to the bot.');
        const change = await op(writer, email);
        await this.repo.updateLeaveRow(row.id, { ...change, error: null, errorAt: null });
        Object.assign(row, change, { error: null, errorAt: null });
      } catch (err) {
        const message = `${name}’s ${what} couldn’t be updated: ${err instanceof Error ? err.message : String(err)}`;
        await this.repo.updateLeaveRow(row.id, { error: message, errorAt: this.now().toUTC().toISO()! });
        Object.assign(row, { error: message, errorAt: this.now().toUTC().toISO()! });
        this.log(message);
        failure = message;
      }
    };

    for (const { row, start, end, moved } of plan) {
      const event: OooEvent = {
        start: DateTime.fromISO(start, { zone: zone }).startOf('day').toISO()!,
        end: DateTime.fromISO(end, { zone: zone }).plus({ days: 1 }).startOf('day').toISO()!,
        timeZone: zone,
        decline,
        message: `I’m on leave until ${dayLabel(end)}.`,
      };
      if (moved) await this.repo.updateLeaveRow(row.id, { startDate: start, endDate: end });
      Object.assign(row, { startDate: start, endDate: end });
      if (!row.eventId) await attempt(row, 'out-of-office event', async (w, e) => ({ eventId: await w.createOutOfOffice(e, event) }));
      else if (moved) await attempt(row, 'out-of-office event', async (w, e) => (await w.updateOutOfOffice(e, row.eventId!, event), {}));
      // Vacation mode's open-ended status covers dated leave while it lasts.
      const text = untilText(end);
      if (start <= today && !onVacation && row.statusText !== text) {
        const expireTime = event.end;
        await attempt(row, 'Chat status', async (w, e) => (await w.setStatus(e, { text, emoji: LEAVE_EMOJI, expireTime: DateTime.fromISO(expireTime).toUTC().toISO()! }), { statusText: text }));
      }
    }
    if (vacationRow && vacationRow.statusText !== VACATION_TEXT) {
      await attempt(vacationRow, 'Chat status', async (w, e) => (await w.setStatus(e, { text: VACATION_TEXT, emoji: LEAVE_EMOJI, expireTime: null }), { statusText: VACATION_TEXT }));
    }

    // Undo what retired rows wrote, then drop them.
    for (const row of (await this.repo.listLeaveRows(userName)).filter((r) => r.gone)) {
      if (row.statusText) await attempt(row, 'Chat status', async (w, e) => (await w.clearStatus(e, row.statusText!), { statusText: null }));
      if (row.eventId && !row.error) await attempt(row, 'out-of-office event', async (w, e) => (await w.deleteOutOfOffice(e, row.eventId!), { eventId: null }));
      if (!row.statusText && !row.eventId) await this.repo.deleteLeaveRow(row.id);
    }
    return failure;
  }

  private async retire(row: LeaveRow): Promise<void> {
    await this.repo.updateLeaveRow(row.id, { gone: true });
  }
}

/** Whether a day is one the person works on that standup: their own week, else the standup's days. */
function worksOn(p: PersonRow, date: string): boolean {
  const weekday = DateTime.fromISO(date).setLocale('en-GB').toFormat('ccc').toLowerCase();
  const week = p.workingDays ?? p.standupDays;
  return week.split(',').map((d) => d.trim()).includes(weekday);
}
