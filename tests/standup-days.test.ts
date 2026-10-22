import { describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import type { RunSummary } from '../src/core/types.js';
import { ANSWERS, makeStack, seedStandup, TENANT, TZ } from './helpers.js';

const alice = { userName: 'users/alice', displayName: 'Alice' };
const bob = { userName: 'users/bob', displayName: 'Bob' };
const admin = { userName: 'users/admin', displayName: 'Admin' };
const selfActor = (m: { userName: string; displayName: string }) => ({ ...m, admin: false });
const manager = { ...admin, admin: false };

/** Daily Standup (Mon–Fri, managed by Admin) has Alice, Bob and Carol; Support (Mon–Fri) has Alice and Dan. */
async function stack(opts: Parameters<typeof makeStack>[0] = {}) {
  const s = await makeStack(opts);
  const team = await seedStandup(s.repo);
  await s.repo.addAdmin(team.id, admin.userName, admin.displayName);
  const support = await s.repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/support', name: 'Support', timezone: TZ });
  await s.repo.upsertParticipant({ standupId: support.id, userName: alice.userName, displayName: alice.displayName });
  await s.repo.upsertParticipant({ standupId: support.id, userName: 'users/dan', displayName: 'Dan' });
  s.clock.set('2026-06-10T08:00'); // Wednesday
  const router = new EventRouter(s.commands, s.service, s.blockers, s.repo, TENANT, s.polls, async () => null, s.schedule);
  const week = async (standupId: number, userName: string) => (await s.repo.listParticipants(standupId)).find((p) => p.userName === userName)!.workingDays;
  return { ...s, router, week, team: (await s.repo.getStandupById(team.id))!, support: (await s.repo.getStandupById(support.id))! };
}

const dm = (user: { userName: string; displayName: string }, text: string) => ({
  type: 'MESSAGE',
  space: { name: `spaces/dm-${user.userName.slice(6)}`, type: 'DM' },
  message: { argumentText: text },
  user: { name: user.userName, displayName: user.displayName, type: 'HUMAN' },
});
const inTeam = (text: string, mentions: { userName: string; displayName: string }[]) => ({
  type: 'MESSAGE',
  space: { name: 'spaces/team', type: 'ROOM' },
  message: { argumentText: text, annotations: mentions.map((m) => ({ type: 'USER_MENTION', userMention: { user: { name: m.userName, displayName: m.displayName, type: 'HUMAN' } } })) },
  user: { name: admin.userName, displayName: admin.displayName, type: 'HUMAN' },
});

describe('standup days are a default', () => {
  it('people without their own days follow the standup, including a change to it (criterion 1)', async () => {
    const { repo, scheduler, clock, adapter, team } = await stack();
    clock.set('2026-06-13T09:30'); // Saturday
    await scheduler.tick();
    expect(await repo.getRun(team.id, '2026-06-13')).toBeNull();
    await repo.updateStandup(team.id, { days: 'mon,tue,wed,thu,fri,sat' });
    await scheduler.tick();
    const run = (await repo.getRun(team.id, '2026-06-13'))!;
    expect((await repo.listRunParticipants(run.id)).map((p) => [p.userName, p.onVacation])).toEqual([['users/alice', false], ['users/bob', false], ['users/carol', false]]);
    expect(adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName).sort()).toEqual(['users/alice', 'users/bob', 'users/carol']);
  });

  it('days set on one standup leave the person’s other standups alone, and can be any day (criteria 2, 3)', async () => {
    const { schedule, week, team, support } = await stack();
    const r = await schedule.setWorkingDays(alice, 'mon-wed,sat,sun', selfActor(alice), 'chat', team.id);
    expect(r).toEqual({ ok: true, status: 'active', message: '✅ Your days on *Daily Standup* are now *Mon–Wed, Sat, Sun*.' });
    expect(await week(team.id, alice.userName)).toBe('mon,tue,wed,sat,sun');
    expect(await week(support.id, alice.userName)).toBeNull();
    expect((await schedule.setWorkingDays(alice, 'reset', selfActor(alice), 'chat', team.id)).message).toBe('✅ You now follow *Daily Standup*’s days (*Mon–Fri*).');
    expect(await week(team.id, alice.userName)).toBeNull();
  });

  it('on a standup day, people whose own days skip it are off, as before (criterion 4)', async () => {
    const { repo, schedule, scheduler, clock, team } = await stack();
    await schedule.setWorkingDays(alice, 'sat,sun', selfActor(alice), 'chat', team.id);
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const run = (await repo.getRun(team.id, '2026-06-10'))!;
    expect((await repo.listRunParticipants(run.id)).map((p) => [p.userName, p.awayReason])).toEqual([['users/alice', 'off_day'], ['users/bob', null], ['users/carol', null]]);
  });

  it('opens a run on an extra day for only the people who work it (criteria 5, 6, 7, 8)', async () => {
    const { repo, schedule, scheduler, clock, adapter, service, team, support } = await stack();
    await schedule.setWorkingDays(alice, 'mon-wed,sat,sun', selfActor(alice), 'chat', team.id);
    clock.set('2026-06-13T09:30'); // Saturday
    await scheduler.tick();
    const run = (await repo.getRun(team.id, '2026-06-13'))!;
    expect((await repo.listRunParticipants(run.id)).map((p) => p.userName)).toEqual(['users/alice']);
    expect(adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName)).toEqual(['users/alice']);
    // Alice follows Support's own days, so Support has nobody on Saturday.
    expect(await repo.getRun(support.id, '2026-06-13')).toBeNull();

    clock.set('2026-06-13T10:31');
    await scheduler.tick();
    expect(adapter.dms.filter((d) => d.kind === 'reminder').map((d) => d.userName)).toEqual(['users/alice']);

    clock.set('2026-06-13T11:31');
    await scheduler.tick();
    const summary = adapter.posts.find((p) => p.kind === 'summary')!.payload as RunSummary;
    expect(summary).toMatchObject({ mandatoryTotal: 1, mandatorySubmitted: 0, missingMandatory: ['Alice'], away: [] });
    clock.set('2026-06-13T12:00');
    expect(await service.submit(run.id, alice.userName, alice.displayName, ANSWERS)).toEqual({ ok: true, late: true, edited: false });
  });

  it('an active working override opens a run on an extra day too (criterion 5)', async () => {
    const { repo, schedule, scheduler, clock, team } = await stack();
    await schedule.setOverride({ target: bob, dates: ['2026-06-13'], working: true, reason: 'release', actor: manager, channel: 'console' });
    clock.set('2026-06-13T09:30');
    await scheduler.tick();
    const run = (await repo.getRun(team.id, '2026-06-13'))!;
    expect((await repo.listRunParticipants(run.id)).map((p) => p.userName)).toEqual(['users/bob']);
  });

  it('run now on any day still treats it as a standup day', async () => {
    const { repo, scheduler, clock, team } = await stack();
    clock.set('2026-06-13T09:00');
    expect(await scheduler.runNow(team)).toBe('started');
    const run = (await repo.getRun(team.id, '2026-06-13'))!;
    expect((await repo.listRunParticipants(run.id)).filter((p) => !p.onVacation).map((p) => p.userName)).toEqual(['users/alice', 'users/bob', 'users/carol']);
  });

  it('posts the weekly digest after the standup’s last default day only (criterion 9)', async () => {
    const { repo, schedule, scheduler, clock, adapter, team } = await stack();
    await repo.updateStandup(team.id, { digestEnabled: true });
    await schedule.setWorkingDays(alice, 'mon-sat', selfActor(alice), 'chat', team.id);
    const digests = () => adapter.posts.filter((p) => p.kind === 'text' && p.text?.includes('weekly digest'));
    for (const day of ['2026-06-12', '2026-06-13']) {
      clock.set(`${day}T09:30`);
      await scheduler.tick();
      clock.set(`${day}T11:31`);
      await scheduler.tick();
    }
    expect(digests()).toHaveLength(1);
    expect(digests()[0]!.text).toContain('2026-06-08 → 2026-06-14');
  });
});

describe('setting days on one standup', () => {
  it('in a DM, asks which standup when the person is on several, and sets the one named (criterion 17)', async () => {
    const { router, week, team, support } = await stack();
    let reply: any = await router.handle(dm(alice, 'days mon-wed,sat,sun'));
    expect(reply.text).toBe(`Which standup? Reply with one of these:\n\`days #${team.id} mon-wed,sat,sun\` for Daily Standup\n\`days #${support.id} mon-wed,sat,sun\` for Support`);
    expect(await week(team.id, alice.userName)).toBeNull();
    reply = await router.handle(dm(alice, `days #${team.id} mon-wed,sat,sun`));
    expect(reply.text).toBe('✅ Your days on *Daily Standup* are now *Mon–Wed, Sat, Sun*.');
    expect(await week(team.id, alice.userName)).toBe('mon,tue,wed,sat,sun');
    expect(await week(support.id, alice.userName)).toBeNull();
    reply = await router.handle(dm(alice, 'days #999 mon'));
    expect(reply.text).toBe('You’re not on that standup.');
    // On one standup, no number is needed.
    reply = await router.handle(dm(bob, 'days mon-thu'));
    expect(reply.text).toBe('✅ Your days on *Daily Standup* are now *Mon–Thu*.');
  });

  it('in a space, days @person sets that standup only and tells them (criteria 18, 20)', async () => {
    const { router, week, adapter, team, support } = await stack();
    const reply: any = await router.handle(inTeam('days @Alice tue-sat', [alice]));
    expect(reply.text).toBe("✅ Alice's days on *Daily Standup* are now *Tue–Sat*.");
    expect(await week(team.id, alice.userName)).toBe('tue,wed,thu,fri,sat');
    expect(await week(support.id, alice.userName)).toBeNull();
    expect(adapter.dms.at(-1)).toEqual({ kind: 'text', userName: alice.userName, text: `📅 Admin set your days on *Daily Standup* to *Tue–Sat*. Reply \`days #${team.id} reset\` to follow the standup again.` });
  });

  it('judges only that standup’s policy and managers (criteria 10, 19)', async () => {
    const { schedule, repo, team, support } = await stack();
    await repo.updateStandup(support.id, { timeOffPolicy: 'managers' });
    expect((await schedule.setWorkingDays(alice, 'mon-thu', selfActor(alice), 'chat', team.id)).ok).toBe(true);
    expect(await schedule.setWorkingDays(alice, 'mon-thu', selfActor(alice), 'chat', support.id)).toEqual({ ok: false, message: 'Only your managers can change your days on *Support* — ask them, or DM them the days you need.' });
    // Admin manages Daily Standup but not Support.
    expect((await schedule.setWorkingDays(alice, 'sat', manager, 'console', team.id)).ok).toBe(true);
    expect(await schedule.setWorkingDays(alice, 'sat', manager, 'console', support.id)).toEqual({ ok: false, message: "Only the managers of *Support* can change Alice's days there." });
    expect(await schedule.setWorkingDays({ userName: 'users/dan', displayName: 'Dan' }, 'sat', manager, 'console', team.id)).toEqual({ ok: false, message: 'Dan isn’t on that standup.' });
  });

  it('names, digests and sends the change for the one standup (criterion 20)', async () => {
    const bodies: any[] = [];
    const webhookFetch = (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), new Response('ok'))) as unknown as typeof fetch;
    const { schedule, repo, team, support } = await stack({ webhookFetch });
    for (const s of [team, support]) await repo.updateStandup(s.id, { webhookUrl: `https://hooks.example.com/${s.id}` });
    await schedule.setWorkingDays(alice, 'mon-wed,sat,sun', selfActor(alice), 'chat', team.id);
    expect(bodies.filter((b) => b.event === 'schedule_change').map((b) => [b.standup.id, b.summary])).toEqual([[team.id, "Alice's days on Daily Standup are now Mon–Wed, Sat, Sun"]]);
    expect((await repo.listUndigestedChanges(team.id, [alice.userName], '')).map((c) => c.summary)).toEqual(["Alice's days on Daily Standup are now Mon–Wed, Sat, Sun"]);
    expect(await repo.listUndigestedChanges(support.id, [alice.userName], '')).toEqual([]);
  });

  it('keeps the all-standups form for existing callers', async () => {
    const { schedule, week, team, support } = await stack();
    const r = await schedule.setWorkingDays(alice, 'mon-thu', selfActor(alice), 'api', 'all');
    expect(r.message).toBe('✅ Your week is now *Mon–Thu* across 2 standups.');
    expect([await week(team.id, alice.userName), await week(support.id, alice.userName)]).toEqual(['mon,tue,wed,thu', 'mon,tue,wed,thu']);
  });
});
