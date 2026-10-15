import { describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { leavePeriods, LeavePresence } from '../src/core/leave-presence.js';
import { ScheduleService } from '../src/core/schedule.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const alice = { userName: 'users/alice', displayName: 'Alice' };
const self = { ...alice, admin: false };
const manager = { userName: 'users/admin', displayName: 'Admin', admin: true };
const EMAIL = 'alice@example.com';

/** Alice on a Mon–Fri standup in Asia/Kolkata, with leave in Chat and Calendar switched on. */
async function leaveStack(on = true) {
  const stack = await makeStack();
  const standup = await seedStandup(stack.repo);
  await stack.repo.setUserEmail(alice.userName, EMAIL);
  if (on) await stack.settings.update({ leaveInChat: true });
  stack.clock.set('2026-06-10T10:00'); // Wednesday
  const off = (dates: string[], actor = self) => stack.schedule.setOverride({ target: alice, dates, working: false, reason: 'annual leave', actor, channel: 'chat' });
  const events = () => [...stack.leaveWriter.events.values()];
  return { ...stack, standup, off, events };
}

describe('the setting', () => {
  it('is off by default and writes nothing until switched on (criteria 1, 3)', async () => {
    const { leave, leaveWriter, off, settings } = await leaveStack(false);
    expect((await settings.get()).leaveInChat).toBe(false);
    expect((await settings.get()).leaveDeclineMode).toBe('none');
    await off(['2026-06-12']);
    await leave.sweep();
    expect(leaveWriter.calls).toEqual([]);
  });
});

describe('dated leave', () => {
  it('bridges a weekend into one period, adds the event at once and the status on the first day (criteria 5, 6, 8, 11)', async () => {
    const { leave, leaveWriter, off, clock, events } = await leaveStack();
    expect((await off(['2026-06-12', '2026-06-15'])).message).toContain('Your Chat status and calendar will show it.');
    await leave.sweep();
    expect(events()).toEqual([{ email: EMAIL, start: '2026-06-12T00:00:00.000+05:30', end: '2026-06-16T00:00:00.000+05:30', timeZone: 'Asia/Kolkata', decline: 'none', message: 'I’m on leave until Mon 15 Jun.' }]);
    expect(leaveWriter.statuses.size).toBe(0);

    clock.set('2026-06-12T09:00');
    await leave.sweep();
    expect(leaveWriter.statuses.get(EMAIL)).toEqual({ text: 'On leave until Mon 15 Jun', emoji: '🌴', expireTime: '2026-06-15T18:30:00.000Z' });
    const calls = leaveWriter.calls.length;
    await leave.sweep();
    expect(leaveWriter.calls).toHaveLength(calls); // nothing changed, nothing written

    // after the leave the row goes; Google expires the status itself
    clock.set('2026-06-16T09:00');
    await leave.sweep();
    expect(leaveWriter.calls).toHaveLength(calls);
  });

  it('moves the event and status when a day is added, and removes both when cancelled (criteria 10, 12)', async () => {
    const { leave, leaveWriter, off, clock, schedule, events } = await leaveStack();
    await off(['2026-06-10', '2026-06-11']);
    await leave.sweep();
    expect(leaveWriter.statuses.get(EMAIL)?.text).toBe('On leave until Thu 11 Jun');
    await off(['2026-06-12']);
    await leave.sweep();
    expect(leaveWriter.calls.filter((c) => c.startsWith('create'))).toHaveLength(1);
    expect(events()[0]!.end).toBe('2026-06-13T00:00:00.000+05:30');
    expect(leaveWriter.statuses.get(EMAIL)?.text).toBe('On leave until Fri 12 Jun');

    for (const d of ['2026-06-10', '2026-06-11', '2026-06-12']) await schedule.cancelOverride(alice, d, manager);
    await leave.sweep();
    expect(events()).toEqual([]);
    expect(leaveWriter.statuses.size).toBe(0);
    clock.set('2026-06-10T11:00');
    await leave.sweep();
    expect(leaveWriter.calls.at(-1)).toBe('delete alice@example.com ev1');
  });

  it('counts a request only once approved, and says so to both sides (criteria 5, 14)', async () => {
    const { leave, leaveWriter, off, repo, standup, schedule, adapter } = await leaveStack();
    await repo.updateStandup(standup.id, { timeOffPolicy: 'approval' });
    await repo.addAdmin(standup.id, manager.userName, manager.displayName);
    const asked = await off(['2026-06-12']);
    expect(asked.message).not.toContain('Chat status');
    await leave.sweep();
    expect(leaveWriter.calls).toEqual([]);
    const pending = (await repo.listPendingOverrides()).map((o) => o.id);
    const decided = await schedule.decide(pending, true, manager, null);
    expect(decided.message).toBe('✅ Approved — Alice has been told. Their Chat status and calendar will show it.');
    expect(adapter.dms.at(-1)?.text).toContain('approved your time off request for Fri 12 Jun. Your Chat status and calendar will show it.');
    await leave.sweep();
    expect(leaveWriter.calls).toEqual(['create alice@example.com']);
  });

  it('tells a manager and the person when the manager marks them away (criterion 14)', async () => {
    const { off, adapter } = await leaveStack();
    expect((await off(['2026-06-12'], manager)).message).toContain('Their Chat status and calendar will show it.');
    expect(adapter.dms.at(-1)?.text).toContain('Your Chat status and calendar will show it.');
  });

  it('declines invites as the setting says (criterion 2)', async () => {
    const { leave, settings, off, events } = await leaveStack();
    await settings.update({ leaveDeclineMode: 'new' });
    await off(['2026-06-12']);
    await leave.sweep();
    expect(events()[0]).toMatchObject({ decline: 'new', message: 'I’m on leave until Fri 12 Jun.' });
  });

  it('is one period per person, however many standups they are on (criterion 4)', async () => {
    const { leave, leaveWriter, off, repo } = await leaveStack();
    const other = await repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/other', name: 'Other', timezone: 'Asia/Kolkata' });
    await repo.upsertParticipant({ standupId: other.id, userName: alice.userName, displayName: 'Alice' });
    await off(['2026-06-12']);
    await leave.sweep();
    expect(leaveWriter.calls).toEqual(['create alice@example.com']);
  });
});

describe('vacation mode', () => {
  it('sets an open-ended status and no event, and clears it on back only if still ours (criteria 7, 9, 13)', async () => {
    const { leave, leaveWriter, repo, commands, standup, settings } = await leaveStack();
    const router = new EventRouter(commands, null as never, null as never, repo, TENANT, null, undefined, null, async () => (await settings.get()).leaveInChat);
    const dm = (text: string) => router.handle({ type: 'MESSAGE', message: { text, argumentText: text }, user: { name: alice.userName, displayName: 'Alice' }, space: { name: 'spaces/dm-alice', spaceType: 'DIRECT_MESSAGE' } }) as Promise<any>;

    expect((await dm('vacation')).text).toContain('Your Chat status will show it.');
    await leave.sweep();
    expect(leaveWriter.statuses.get(EMAIL)).toEqual({ text: 'On leave', emoji: '🌴', expireTime: null });
    expect(leaveWriter.events.size).toBe(0);

    expect((await dm('back')).text).toContain('Your “On leave” status is cleared.');
    await leave.sweep();
    expect(leaveWriter.statuses.size).toBe(0);

    // someone who set their own status since keeps it
    await dm('vacation');
    await leave.sweep();
    leaveWriter.statuses.set(EMAIL, { text: 'Hiking', emoji: '🥾', expireTime: null });
    await dm('back');
    await leave.sweep();
    expect(leaveWriter.statuses.get(EMAIL)?.text).toBe('Hiking');

    // a manager pausing one standup of two is not the person on leave
    const other = await repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/other', name: 'Other', timezone: 'Asia/Kolkata' });
    await repo.upsertParticipant({ standupId: other.id, userName: alice.userName, displayName: 'Alice' });
    await repo.setParticipantVacation(standup.id, alice.userName, true);
    const calls = leaveWriter.calls.length;
    await leave.sweep();
    expect(leaveWriter.calls).toHaveLength(calls);
  });

  it('lets an open-ended status stand in for dated leave while vacation lasts', async () => {
    const { leave, leaveWriter, off, repo } = await leaveStack();
    await repo.setVacationForUser(alice.userName, true);
    await off(['2026-06-10']);
    await leave.sweep();
    expect(leaveWriter.statuses.get(EMAIL)?.text).toBe('On leave');
    await repo.setVacationForUser(alice.userName, false);
    await leave.sweep();
    expect(leaveWriter.statuses.get(EMAIL)?.text).toBe('On leave until Wed 10 Jun');
  });
});

describe('when Google says no', () => {
  it('records the failure, retries after an hour, and clears it once it works (criterion 15)', async () => {
    const { leave, leaveWriter, off, clock, settings, repo } = await leaveStack();
    leaveWriter.fail.calendar = new Error('Google refused it (403).');
    await off(['2026-06-12']);
    await leave.sweep();
    expect(await settings.get()).toMatchObject({ leaveSyncError: 'Alice’s out-of-office event couldn’t be updated: Google refused it (403).', leaveSyncErrorAt: '2026-06-10T04:30:00.000Z' });

    leaveWriter.fail = {};
    clock.set('2026-06-10T10:30');
    await leave.sweep();
    expect(leaveWriter.events.size).toBe(0); // waits out the hour
    clock.set('2026-06-10T11:01');
    await leave.sweep();
    expect(leaveWriter.events.size).toBe(1);
    expect((await settings.get()).leaveSyncError).toBe('');

    // no service-account key
    const keyless = new LeavePresence(repo, settings, async () => null, clock.now);
    await off(['2026-06-19']);
    await keyless.sweep();
    expect((await settings.get()).leaveSyncError).toBe('Alice’s out-of-office event couldn’t be updated: it needs the service-account key under Settings › Google Chat.');
  });

  it('explains a missing email', async () => {
    const { leave, off, settings, repo } = await leaveStack();
    await repo.setUserEmail(alice.userName, '');
    await off(['2026-06-12']);
    await leave.sweep();
    expect((await settings.get()).leaveSyncError).toBe('Alice’s out-of-office event couldn’t be updated: AsyncUp doesn’t know their email yet. It comes from the Directory, or from their first message to the bot.');
  });
});

describe('people off every roster', () => {
  it('are still named by the name on their days off', async () => {
    const { leave, off, settings, repo, standup } = await leaveStack();
    await repo.setUserEmail(alice.userName, '');
    await off(['2026-06-12']);
    await repo.removeParticipant(standup.id, alice.userName);
    await leave.sweep();
    expect((await settings.get()).leaveSyncError).toStartWith('Alice’s out-of-office event');
  });
});

describe('older wiring', () => {
  it('says nothing about Chat and writes on the real clock when not told otherwise', async () => {
    const { repo, adapter, settings } = await leaveStack();
    const bare = new ScheduleService(repo, adapter);
    const far = '2099-01-02';
    expect((await bare.setOverride({ target: alice, dates: [far], working: false, reason: '', actor: manager, channel: 'chat' })).message).not.toContain('Chat status');
    await new LeavePresence(repo, settings, async () => null).sweep();
    expect((await settings.get()).leaveSyncError).toContain('needs the service-account key');
  });
});

describe('leave periods', () => {
  it('bridges only gaps the person doesn’t work', () => {
    const weekdays = (d: string) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
    expect(leavePeriods(['2026-06-15', '2026-06-12', '2026-06-12'], weekdays)).toEqual([{ start: '2026-06-12', end: '2026-06-15' }]);
    expect(leavePeriods(['2026-06-10', '2026-06-12'], weekdays)).toEqual([{ start: '2026-06-10', end: '2026-06-10' }, { start: '2026-06-12', end: '2026-06-12' }]);
    expect(leavePeriods([], weekdays)).toEqual([]);
  });
});

describe('the scheduler', () => {
  it('sweeps leave on every tick', async () => {
    const { scheduler, leaveWriter, off } = await leaveStack();
    await off(['2026-06-12']);
    await scheduler.tick();
    expect(leaveWriter.calls).toEqual(['create alice@example.com']);
  });
});
