import { describe, expect, it } from 'bun:test';
import { DateTime } from 'luxon';
import { FakeAdapter } from '../src/adapters/fake/adapter.js';
import {
  ADHOC,
  AWAY_LABEL,
  dayStatus,
  describeDates,
  describeWorkingDays,
  digestText,
  parseDateSpec,
  parseWorkingDays,
  ScheduleService,
  weekdayOf,
} from '../src/core/schedule.js';
import { makeStack, seedStandup, TZ } from './helpers.js';

const WED = DateTime.fromISO('2026-06-10T10:00', { zone: TZ }); // Wednesday

const alice = { userName: 'users/alice', displayName: 'Alice' };
const bob = { userName: 'users/bob', displayName: 'Bob' };
const carol = { userName: 'users/carol', displayName: 'Carol' };
const admin = { userName: 'users/admin', displayName: 'Admin' };
const selfActor = (m: { userName: string; displayName: string }, manager = false) => ({ ...m, self: true, manager });
const managerActor = { ...admin, self: false, manager: true };

describe('parseWorkingDays', () => {
  it('normalises ranges, lists, long names and the keywords', () => {
    expect(parseWorkingDays('mon-thu')).toEqual({ ok: true, value: 'mon,tue,wed,thu' });
    expect(parseWorkingDays('Mon, Wed, fri')).toEqual({ ok: true, value: 'mon,wed,fri' });
    expect(parseWorkingDays('tuesday - saturday')).toEqual({ ok: true, value: 'tue,wed,thu,fri,sat' });
    expect(parseWorkingDays('weekdays')).toEqual({ ok: true, value: 'mon,tue,wed,thu,fri' });
    expect(parseWorkingDays('adhoc')).toEqual({ ok: true, value: ADHOC });
    expect(parseWorkingDays('ad-hoc')).toEqual({ ok: true, value: ADHOC });
    for (const word of ['reset', 'standup', 'default', 'follow']) expect(parseWorkingDays(word)).toEqual({ ok: true, value: null });
  });

  it('explains bad input', () => {
    expect(parseWorkingDays('xyz')).toMatchObject({ ok: false, message: expect.stringContaining('"xyz" isn\'t a day') });
    expect(parseWorkingDays('thu-mon')).toMatchObject({ ok: false, message: expect.stringContaining('runs backwards') });
    expect(parseWorkingDays('  ')).toMatchObject({ ok: false, message: expect.stringContaining('Say which days') });
  });
});

describe('describeWorkingDays', () => {
  it('collapses runs of consecutive days', () => {
    expect(describeWorkingDays(null)).toBe('Follows the standup');
    expect(describeWorkingDays(ADHOC)).toBe('Ad hoc');
    expect(describeWorkingDays('mon,tue,wed,thu')).toBe('Mon–Thu');
    expect(describeWorkingDays('mon,tue,wed,fri')).toBe('Mon–Wed, Fri');
    expect(describeWorkingDays('mon,tue')).toBe('Mon, Tue');
    expect(describeWorkingDays('mon,wed')).toBe('Mon, Wed');
    expect(describeWorkingDays('sat')).toBe('Sat');
  });
});

describe('dayStatus', () => {
  const override = (working: boolean, status = 'active') => ({ working, status }) as any;
  it('lets a dated override win, then vacation, then the personal week', () => {
    expect(weekdayOf('2026-06-10')).toBe('wed');
    expect(dayStatus({ onVacation: true, workingDays: null }, '2026-06-10', override(true))).toEqual({ expected: true });
    expect(dayStatus({ onVacation: false, workingDays: null }, '2026-06-10', override(false))).toEqual({ expected: false, reason: 'day_off' });
    expect(dayStatus({ onVacation: false, workingDays: null }, '2026-06-10', override(false, 'pending'))).toEqual({ expected: true });
    expect(dayStatus({ onVacation: true, workingDays: null }, '2026-06-10', null)).toEqual({ expected: false, reason: 'vacation' });
    expect(dayStatus({ onVacation: false, workingDays: null }, '2026-06-10', undefined)).toEqual({ expected: true });
    expect(dayStatus({ onVacation: false, workingDays: ADHOC }, '2026-06-10', null)).toEqual({ expected: false, reason: 'off_day' });
    expect(dayStatus({ onVacation: false, workingDays: 'mon,tue,wed' }, '2026-06-10', null)).toEqual({ expected: true });
    expect(dayStatus({ onVacation: false, workingDays: 'mon,tue' }, '2026-06-10', null)).toEqual({ expected: false, reason: 'off_day' });
    expect(AWAY_LABEL.off_day).toBe('Not a working day');
  });
});

describe('parseDateSpec', () => {
  const spec = (text: string) => parseDateSpec(text, WED);
  it('reads today, tomorrow, weekdays and explicit dates, leaving the reason', () => {
    expect(spec('today')).toEqual({ ok: true, dates: ['2026-06-10'], rest: '' });
    expect(spec('tomorrow comp off')).toEqual({ ok: true, dates: ['2026-06-11'], rest: 'comp off' });
    expect(spec('fri')).toEqual({ ok: true, dates: ['2026-06-12'], rest: '' });
    expect(spec('Wednesday')).toEqual({ ok: true, dates: ['2026-06-10'], rest: '' });
    expect(spec('19 jun')).toEqual({ ok: true, dates: ['2026-06-19'], rest: '' });
    expect(spec('19th June dentist')).toEqual({ ok: true, dates: ['2026-06-19'], rest: 'dentist' });
    expect(spec('jun 19')).toEqual({ ok: true, dates: ['2026-06-19'], rest: '' });
    expect(spec('19-jun')).toEqual({ ok: true, dates: ['2026-06-19'], rest: '' });
    expect(spec('2026-06-19 sick')).toEqual({ ok: true, dates: ['2026-06-19'], rest: 'sick' });
    expect(spec('19 jun 2027')).toEqual({ ok: true, dates: ['2027-06-19'], rest: '' });
    expect(spec('5 jun')).toEqual({ ok: true, dates: ['2026-06-05'], rest: '' });
    expect(spec('2 jan')).toEqual({ ok: true, dates: ['2027-01-02'], rest: '' });
  });

  it('expands ranges joined by to, dashes or until', () => {
    expect(spec('22 jun to 24 jun sick leave')).toEqual({ ok: true, dates: ['2026-06-22', '2026-06-23', '2026-06-24'], rest: 'sick leave' });
    expect(spec('22 jun - 23 jun')).toEqual({ ok: true, dates: ['2026-06-22', '2026-06-23'], rest: '' });
    expect(spec('mon until wed')).toEqual({ ok: true, dates: ['2026-06-15', '2026-06-16', '2026-06-17'], rest: '' });
    expect(describeDates(['2026-06-22', '2026-06-23', '2026-06-24'])).toBe('Mon 22 Jun – Wed 24 Jun');
    expect(describeDates(['2026-06-19'])).toBe('Fri 19 Jun');
  });

  it('explains what it could not read', () => {
    expect(spec('')).toMatchObject({ ok: false, message: expect.stringContaining('Say when') });
    expect(spec('xyz')).toMatchObject({ ok: false });
    expect(spec('31 feb')).toMatchObject({ ok: false });
    expect(spec('2026-13-40')).toMatchObject({ ok: false });
    expect(spec('22 jun to')).toMatchObject({ ok: false, message: expect.stringContaining('end of that range') });
    expect(spec('24 jun to 22 jun')).toMatchObject({ ok: false, message: expect.stringContaining('ends before') });
    expect(spec('1 jun to 31 jul')).toMatchObject({ ok: false, message: expect.stringContaining('31 days') });
  });
});

describe('ScheduleService', () => {
  async function stack() {
    const s = await makeStack();
    const standup = await seedStandup(s.repo);
    s.clock.set('2026-06-10T10:00');
    return { ...s, standup };
  }

  it('sets a personal week for oneself, logs it for the digest and applies it to today', async () => {
    const { schedule, repo, standup, adapter, scheduler } = await stack();
    await scheduler.tick(); // opens today's run (Wed) with everyone expected
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    const r = await schedule.setWorkingDays(alice, 'mon-tue', selfActor(alice), 'chat');
    expect(r).toEqual({ ok: true, status: 'active', message: expect.stringContaining('Your week is now *Mon, Tue* across 1 standup') });
    expect(await repo.getUserWorkingDays('users/alice')).toBe('mon,tue');
    expect((await repo.listUndigestedChanges(['users/alice'])).map((c) => c.summary)).toEqual(["Alice's week is now Mon, Tue"]);
    const rp = (await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/alice')!;
    expect(rp).toMatchObject({ onVacation: true, awayReason: 'off_day' });
    expect(adapter.dms).toHaveLength(3); // prompts only — no DM to yourself
    // back to the standup week restores today
    await schedule.setWorkingDays(alice, 'reset', selfActor(alice), 'chat');
    expect((await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/alice')).toMatchObject({ onVacation: false, awayReason: null });
    expect((await schedule.setWorkingDays(alice, 'adhoc', selfActor(alice), 'chat')).message).toContain('`working <date>`');
  });

  it('refuses bad patterns, strangers, and self-service under a managers-only policy', async () => {
    const { schedule, repo, standup } = await stack();
    expect(await schedule.setWorkingDays(alice, 'nope', selfActor(alice), 'chat')).toMatchObject({ ok: false });
    expect(await schedule.setWorkingDays({ userName: 'users/zed', displayName: 'Zed' }, 'mon', selfActor({ userName: 'users/zed', displayName: 'Zed' }), 'chat')).toEqual({ ok: false, message: "You're not on any standup roster yet." });
    expect(await schedule.setWorkingDays({ userName: 'users/zed', displayName: 'Zed' }, 'mon', managerActor, 'chat')).toEqual({ ok: false, message: "Zed isn't on any standup roster." });
    await repo.updateStandup(standup.id, { timeOffPolicy: 'managers' });
    expect(await schedule.setWorkingDays(alice, 'mon', selfActor(alice), 'chat')).toMatchObject({ ok: false, message: expect.stringContaining('Only your managers') });
    // a manager changing their own week is fine
    expect((await schedule.setWorkingDays(alice, 'mon', selfActor(alice, true), 'chat')).ok).toBe(true);
  });

  it('a manager sets someone else’s week and the person is told', async () => {
    const { schedule, adapter } = await stack();
    const r = await schedule.setWorkingDays(bob, 'tue-sat', managerActor, 'console');
    expect(r.message).toContain("Bob's week is now *Tue–Sat*");
    expect(adapter.dms.at(-1)).toMatchObject({ kind: 'text', userName: 'users/bob', text: expect.stringContaining('Admin set your week to *Tue–Sat*') });
  });

  it('self-service days off apply immediately, reach today’s open run and can be cancelled', async () => {
    const { schedule, repo, standup, scheduler, adapter } = await stack();
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    const r = await schedule.setOverride({ target: alice, dates: ['2026-06-10', '2026-06-11'], working: false, reason: 'comp off', actor: selfActor(alice), channel: 'chat' });
    // (toMatchObject with asymmetric matchers rewrites the received object in Bun — assert on plain values)
    expect(r.ok).toBe(true);
    const message = (r as { message: string }).message;
    expect(message).toContain('Wed 10 Jun – Thu 11 Jun marked off (comp off)');
    expect(message).toContain('managers get today');
    expect((await repo.getOverride('users/alice', '2026-06-11'))!).toMatchObject({ working: false, reason: 'comp off', status: 'active', setByDisplayName: 'Alice', channel: 'chat' });
    expect((await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/alice')).toMatchObject({ onVacation: true, awayReason: 'day_off' });
    expect((await schedule.listUpcoming('users/alice', TZ)).map((o) => o.date)).toEqual(['2026-06-10', '2026-06-11']);

    const cancelled = await schedule.cancelOverride(alice, '2026-06-10', selfActor(alice));
    expect(cancelled.message).toContain('back to your usual week');
    expect((await repo.getOverride('users/alice', '2026-06-10'))!.status).toBe('withdrawn');
    expect((await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/alice')).toMatchObject({ onVacation: false, awayReason: null });
    expect(await schedule.cancelOverride(alice, '2026-06-10', selfActor(alice))).toMatchObject({ ok: false, message: 'Nothing is set for Wed 10 Jun.' });
    expect(await schedule.cancelOverride(alice, '2026-06-11', { ...bob, self: false, manager: false })).toMatchObject({ ok: false, message: expect.stringContaining('Only managers') });
    expect(adapter.dms.filter((d) => d.kind === 'text')).toHaveLength(0);
  });

  it('refuses past days and managers-only policies for self-service, but not for managers', async () => {
    const { schedule, repo, standup, adapter } = await stack();
    expect(await schedule.setOverride({ target: alice, dates: ['2026-06-09'], working: false, reason: '', actor: selfActor(alice), channel: 'chat' })).toMatchObject({ ok: false, message: 'Past days can only be changed by a manager.' });
    await repo.updateStandup(standup.id, { timeOffPolicy: 'managers' });
    expect(await schedule.setOverride({ target: alice, dates: ['2026-06-12'], working: false, reason: '', actor: selfActor(alice), channel: 'chat' })).toMatchObject({ ok: false, message: expect.stringContaining('Only your managers can mark you away') });
    const r = await schedule.setOverride({ target: alice, dates: ['2026-06-09'], working: true, reason: 'release', actor: managerActor, channel: 'console' });
    expect(r).toMatchObject({ ok: true, status: 'active', message: '✅ Alice is marked *working* on Tue 9 Jun for Daily Standup.' });
    expect(adapter.dms.at(-1)).toMatchObject({ kind: 'text', userName: 'users/alice', text: expect.stringContaining('marked you *working* on Tue 9 Jun (release)') });
    const off = await schedule.setOverride({ target: alice, dates: ['2026-06-12'], working: false, reason: '', actor: managerActor, channel: 'console' });
    expect(off.message).toBe('🏖️ Fri 12 Jun marked off for Daily Standup — no prompt, not counted as missing. Undo with `off cancel 2026-06-12`.');
    expect(adapter.dms.at(-1)).toMatchObject({ userName: 'users/alice', text: expect.stringContaining('reply `working 2026-06-12`') });
    expect(await repo.listUndigestedChanges(['users/alice'])).toEqual([]); // manager changes are not digested
    expect(await schedule.setOverride({ target: { userName: 'users/zed', displayName: 'Zed' }, dates: ['2026-06-12'], working: false, reason: '', actor: managerActor, channel: 'console' })).toMatchObject({ ok: false });
  });

  it('routes requests to managers under an approval policy, then applies the decision', async () => {
    const { schedule, repo, standup, adapter, scheduler } = await stack();
    await repo.updateStandup(standup.id, { timeOffPolicy: 'approval' });
    await repo.addAdmin(standup.id, admin.userName, admin.displayName);
    await repo.addAdmin(standup.id, alice.userName, alice.displayName); // requesters never get their own request card
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;

    const r = await schedule.setOverride({ target: alice, dates: ['2026-06-10', '2026-06-11'], working: false, reason: 'sick', actor: selfActor(alice), channel: 'chat' });
    expect(r).toMatchObject({ ok: true, status: 'pending', message: expect.stringContaining('Sent to the managers of Daily Standup for approval') });
    const card = adapter.dms.find((d) => d.kind === 'timeOffRequest')!;
    expect(card).toMatchObject({ userName: 'users/admin', standupId: standup.id });
    expect(card.request).toMatchObject({ person: alice, dates: ['2026-06-10', '2026-06-11'], working: false, reason: 'sick' });
    expect(adapter.dms.filter((d) => d.kind === 'timeOffRequest')).toHaveLength(1);
    expect((await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/alice')!.awayReason).toBeNull();
    expect((await repo.listPendingOverrides()).map((o) => o.date)).toEqual(['2026-06-10', '2026-06-11']);
    expect(await repo.listPendingOverrides([])).toEqual([]);

    // only managers decide
    expect(await schedule.decide(card.request!.ids, true, { ...bob, admin: false }, null)).toMatchObject({ ok: false, message: "Only Alice's managers can decide this." });
    const approved = await schedule.decide(card.request!.ids, true, { ...admin, admin: false }, 'feel better');
    expect(approved).toMatchObject({ ok: true, message: '✅ Approved — Alice has been told.' });
    expect((await repo.getOverride('users/alice', '2026-06-11'))!).toMatchObject({ status: 'active', decidedByDisplayName: 'Admin', decisionNote: 'feel better' });
    expect((await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/alice')).toMatchObject({ awayReason: 'day_off' });
    expect(adapter.dms.at(-1)).toMatchObject({ userName: 'users/alice', text: expect.stringContaining('approved your time off request for Wed 10 Jun – Thu 11 Jun. “feel better”') });
    expect(await schedule.decide(card.request!.ids, true, { ...admin, admin: true }, null)).toMatchObject({ ok: false, message: 'That request was already decided or withdrawn.' });

    // a declined request is recorded with its note and the person hears why
    await schedule.setOverride({ target: bob, dates: ['2026-06-12'], working: true, reason: '', actor: selfActor(bob), channel: 'console' });
    const pending = await repo.listPendingOverrides(['users/bob']);
    const declined = await schedule.decide(pending.map((o) => o.id), false, { userName: 'operator', displayName: 'Operator', admin: true }, 'not this week');
    expect(declined.message).toBe('❌ Declined — Bob has been told.');
    expect((await repo.getOverride('users/bob', '2026-06-12'))!.status).toBe('declined');
    expect(adapter.dms.at(-1)).toMatchObject({ userName: 'users/bob', text: expect.stringContaining('declined your working request for Fri 12 Jun. “not this week”') });
    expect(await schedule.decide([999], true, { ...admin, admin: true }, null)).toMatchObject({ ok: false });
  });

  it('starts a run with the right people away and lapses unanswered requests at the deadline', async () => {
    const { schedule, repo, standup, adapter, scheduler, clock } = await stack();
    await repo.addAdmin(standup.id, admin.userName, admin.displayName);
    await repo.setWorkingDaysForUser('users/alice', 'mon,tue'); // Wed is not her day
    await repo.setParticipantVacation(standup.id, 'users/carol', true);
    await schedule.setOverride({ target: carol, dates: ['2026-06-10'], working: true, reason: '', actor: managerActor, channel: 'console' }); // working beats vacation
    await schedule.setOverride({ target: bob, dates: ['2026-06-10'], working: false, reason: 'dentist', actor: selfActor(bob), channel: 'chat' });
    await repo.updateStandup(standup.id, { timeOffPolicy: 'approval' });
    await schedule.setOverride({ target: alice, dates: ['2026-06-10'], working: true, reason: 'swap', actor: selfActor(alice), channel: 'chat' }); // pending
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    const by = Object.fromEntries((await repo.listRunParticipants(run.id)).map((p) => [p.userName, { onVacation: p.onVacation, awayReason: p.awayReason }]));
    expect(by).toEqual({
      'users/alice': { onVacation: true, awayReason: 'off_day' },
      'users/bob': { onVacation: true, awayReason: 'day_off' },
      'users/carol': { onVacation: false, awayReason: null },
    });
    expect(adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName)).toEqual(['users/carol']);

    clock.set('2026-06-10T11:31');
    await scheduler.tick();
    expect((await repo.getRun(standup.id, '2026-06-10'))!.status).toBe('closed');
    expect((await repo.getOverride('users/alice', '2026-06-10'))!.status).toBe('expired');
    expect(adapter.dms.find((d) => d.kind === 'text' && d.userName === 'users/alice')!.text).toContain("request for Wed 10 Jun wasn't answered");
    const digest = adapter.dms.find((d) => d.kind === 'text' && d.userName === 'users/admin')!;
    expect(digest.text).toBe('📅 Schedule changes for *Daily Standup* (1 change):\n• Bob is off Wed 10 Jun (dentist) — via chat\nReview or undo under Team in the console.');
    expect(await repo.listUndigestedChanges(['users/bob'])).toEqual([]);
    // a second close sends nothing new
    const before = adapter.dms.length;
    await schedule.onRunClosed(standup, run);
    expect(adapter.dms.length).toBe(before);
  });

  it('leaves calendar and vacation absences alone when re-evaluating an open run', async () => {
    const { schedule, repo, standup, scheduler } = await stack();
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    await repo.markRunVacation(run.id, 'users/alice');
    await schedule.setOverride({ target: alice, dates: ['2026-06-10'], working: true, reason: '', actor: managerActor, channel: 'console' });
    expect((await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/alice')).toMatchObject({ onVacation: true, awayReason: 'calendar_ooo' });
    // nothing to do when there is no open run or the person is not on the roster
    await schedule.applyToOpenRuns('users/alice', '2026-06-11');
    await schedule.applyToOpenRuns('users/zed', '2026-06-10');
    expect(digestText(standup, [{ id: 1, userName: 'users/a', displayName: 'A', summary: 'A is off Fri 12 Jun', byDisplayName: 'A', channel: 'console', at: '' }])).toContain('(1 change)');
  });

  it('logs delivery failures instead of failing the change', async () => {
    const { repo, standup, clock } = await stack();
    await repo.updateStandup(standup.id, { timeOffPolicy: 'approval' });
    await repo.addAdmin(standup.id, admin.userName, admin.displayName);
    const failing = new FakeAdapter();
    failing.sendDm = async () => { throw new Error('dm down'); };
    failing.sendTimeOffRequest = async () => { throw new Error('card down'); };
    const logs: string[] = [];
    const svc = new ScheduleService(repo, failing, clock.now, null, (m) => logs.push(m));
    expect((await svc.setWorkingDays(bob, 'mon', managerActor, 'console')).ok).toBe(true);
    expect(await svc.setOverride({ target: alice, dates: ['2026-06-12'], working: false, reason: '', actor: selfActor(alice), channel: 'chat' })).toMatchObject({ status: 'pending' });
    await repo.logScheduleChange({ userName: 'users/bob', displayName: 'Bob', summary: 'x', byDisplayName: 'Bob', channel: 'chat', at: '2026-06-10T00:00:00Z' });
    await svc.onRunClosed(standup, { id: 1, standupId: standup.id, date: '2026-06-10', threadKey: 'k', status: 'closed' });
    expect(logs).toEqual([
      'schedule DM to users/bob failed: Error: dm down',
      'time-off request to users/admin failed: Error: card down',
      'schedule digest to users/admin failed: Error: dm down',
    ]);
    const defaults = new ScheduleService(repo, failing);
    expect((await defaults.setWorkingDays(bob, 'reset', managerActor, 'console')).ok).toBe(true);
  });
});
