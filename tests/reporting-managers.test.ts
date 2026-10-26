import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { createServer } from '../src/server.js';
import { ScheduleService } from '../src/core/schedule.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const alice = { userName: 'users/alice', displayName: 'Alice' };
const bob = { userName: 'users/bob', displayName: 'Bob' };
const carol = { userName: 'users/carol', displayName: 'Carol' };
const admin = { userName: 'users/admin', displayName: 'Admin' };
const selfActor = (m: { userName: string; displayName: string }) => ({ ...m, admin: false });

// --- the reporting-manager data model lives on the participant row ---

describe('repo: reporting managers', () => {
  it('sets, reads and clears who a participant reports to on a standup', async () => {
    const { repo } = await makeStack();
    const standup = await seedStandup(repo);
    expect(await repo.getReportingManager(standup.id, 'users/bob')).toBeNull();
    await repo.setReportingManager(standup.id, 'users/bob', carol);
    expect(await repo.getReportingManager(standup.id, 'users/bob')).toEqual({ userName: 'users/carol', displayName: 'Carol' });
    expect((await repo.listParticipants(standup.id)).find((p) => p.userName === 'users/bob')).toMatchObject({ reportingManager: 'users/carol', reportingManagerName: 'Carol' });
    await repo.setReportingManager(standup.id, 'users/bob', null);
    expect(await repo.getReportingManager(standup.id, 'users/bob')).toBeNull();
  });

  it('offers managers across the tenant as candidates, and tells reports from managers', async () => {
    const { repo } = await makeStack();
    const a = await seedStandup(repo, { spaceName: 'spaces/a' });
    const b = await seedStandup(repo, { spaceName: 'spaces/b' });
    await repo.addAdmin(a.id, 'users/alice', 'Alice');
    await repo.addAdmin(b.id, 'users/alice', 'Alice'); // same person, both standups — listed once
    await repo.addAdmin(b.id, 'users/carol', 'Carol');
    expect(await repo.listManagerCandidates(TENANT)).toEqual([
      { userName: 'users/alice', displayName: 'Alice' },
      { userName: 'users/carol', displayName: 'Carol' },
    ]);
    expect(await repo.isManagerAnywhere(TENANT, 'users/alice')).toBe(true);
    expect(await repo.isManagerAnywhere(TENANT, 'users/bob')).toBe(false);

    await repo.setReportingManager(a.id, 'users/bob', carol);
    await repo.setReportingManager(b.id, 'users/bob', carol);
    expect(await repo.listReportsOf('users/carol')).toEqual(['users/bob']);
    expect(await repo.isReportingManagerOf('users/carol', 'users/bob')).toBe(true);
    expect(await repo.isReportingManagerOf('users/alice', 'users/bob')).toBe(false);
  });
});

// --- the approval flow: a reporting manager is an extra approver for days off ---

async function coreStack() {
  const s = await makeStack();
  const standup = await seedStandup(s.repo);
  await s.repo.addAdmin(standup.id, admin.userName, admin.displayName);
  await s.repo.updateStandup(standup.id, { timeOffPolicy: 'approval' });
  s.clock.set('2026-06-10T10:00'); // Wednesday
  return { ...s, standup };
}

describe('reporting managers in the approval flow', () => {
  it('sends a day-off request to the reporting manager and lets them approve it, like a manager (criteria 6, 8, 10)', async () => {
    const { schedule, repo, adapter, scheduler, standup } = await coreStack();
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    await repo.setReportingManager(standup.id, 'users/bob', carol);

    const r = await schedule.setOverride({ target: bob, dates: ['2026-06-11'], working: false, reason: 'sick', actor: selfActor(bob), channel: 'chat' });
    expect(r).toMatchObject({ ok: true, status: 'pending' });
    const toCarol = adapter.dms.filter((d) => d.kind === 'timeOffRequest' && d.userName === 'users/carol');
    expect(toCarol).toHaveLength(1);
    expect(adapter.dms.some((d) => d.kind === 'timeOffRequest' && d.userName === 'users/admin')).toBe(true);

    // Carol manages no standup, but she is Bob's reporting manager, so she can decide his day off.
    const approved = await schedule.decide(toCarol[0]!.request!.ids, true, selfActor(carol), null);
    expect(approved).toMatchObject({ ok: true });
    expect((await repo.getOverride('users/bob', '2026-06-11'))!.status).toBe('active');
    expect(adapter.dms.at(-1)).toMatchObject({ userName: 'users/bob', text: expect.stringContaining('approved your time off request') });

    // Same downstream state as an admin approval would leave (criterion 10).
    await schedule.setOverride({ target: bob, dates: ['2026-06-10'], working: false, reason: 'sick', actor: selfActor(bob), channel: 'chat' });
    const pendingToday = (await repo.listPendingOverrides(['users/bob'])).map((o) => o.id);
    await schedule.decide(pendingToday, true, selfActor(carol), null);
    expect((await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/bob')).toMatchObject({ awayReason: 'day_off' });
  });

  it('does not involve the reporting manager in a working request (criteria 7, 9)', async () => {
    const { schedule, repo, adapter, standup } = await coreStack();
    await repo.setReportingManager(standup.id, 'users/bob', carol);
    // Bob asks to work a day he is normally off.
    await repo.setWorkingDays(standup.id, 'users/bob', 'mon,tue'); // Wed/Thu now off for Bob
    const r = await schedule.setOverride({ target: bob, dates: ['2026-06-11'], working: true, reason: 'release', actor: selfActor(bob), channel: 'chat' });
    expect(r).toMatchObject({ ok: true, status: 'pending' });
    expect(adapter.dms.some((d) => d.kind === 'timeOffRequest' && d.userName === 'users/carol')).toBe(false);
    // And she cannot decide a working request.
    const ids = (await repo.listPendingOverrides(['users/bob'])).map((o) => o.id);
    expect(await schedule.decide(ids, true, selfActor(carol), null)).toMatchObject({ ok: false, message: "Only Bob's managers can decide this." });
  });

  it('sends the reporting manager just one card when they are also a standup manager', async () => {
    const { schedule, repo, adapter, standup } = await coreStack();
    await repo.setReportingManager(standup.id, 'users/bob', admin); // admin is already a manager
    await schedule.setOverride({ target: bob, dates: ['2026-06-11'], working: false, reason: 'sick', actor: selfActor(bob), channel: 'chat' });
    expect(adapter.dms.filter((d) => d.kind === 'timeOffRequest' && d.userName === 'users/admin')).toHaveLength(1);
  });

  it('skips a reporting manager that is the requester themselves', async () => {
    const { schedule, repo, adapter, standup } = await coreStack();
    await repo.setReportingManager(standup.id, 'users/bob', bob); // self (can't happen via the API, guarded here)
    await schedule.setOverride({ target: bob, dates: ['2026-06-11'], working: false, reason: 'sick', actor: selfActor(bob), channel: 'chat' });
    expect(adapter.dms.filter((d) => d.kind === 'timeOffRequest' && d.userName === 'users/bob')).toHaveLength(0);
  });

  it('proceeds when the reporting manager cannot be DMed', async () => {
    const { schedule, repo, adapter, standup } = await coreStack();
    await repo.setReportingManager(standup.id, 'users/bob', carol);
    adapter.sendTimeOffRequest = async (userName: string) => {
      if (userName === 'users/carol') throw new Error('cannot DM');
    };
    const r = await schedule.setOverride({ target: bob, dates: ['2026-06-11'], working: false, reason: 'sick', actor: selfActor(bob), channel: 'chat' });
    expect(r).toMatchObject({ ok: true, status: 'pending' }); // the request still stands
    expect((await repo.listPendingOverrides(['users/bob'])).map((o) => o.date)).toEqual(['2026-06-11']);
  });
});

describe('setting a whole week under an approval policy', () => {
  it('is refused across standups when any needs approval', async () => {
    const { repo, schedule } = await makeStack();
    const a = await seedStandup(repo, { spaceName: 'spaces/a' });
    const b = await seedStandup(repo, { spaceName: 'spaces/b' });
    await repo.updateStandup(b.id, { timeOffPolicy: 'approval' });
    const r = await schedule.setWorkingDays(alice, 'mon-thu', selfActor(alice), 'api', 'all');
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('Only your managers can change your week here') });
  });
});

// --- the API: assigning a reporting manager, and seeing/deciding requests as one ---

const SECRET = 'rm-test-secret';
const OPERATOR = 'rm-operator';
const CSRF = { 'x-requested-with': 'asyncup', 'content-type': 'application/json' };
let close: (() => void) | null = null;
afterEach(() => close?.());

async function server() {
  const stack = await makeStack();
  const standup = await seedStandup(stack.repo);
  await stack.repo.addAdmin(standup.id, 'users/alice', 'Alice'); // a manager, so a candidate
  await stack.repo.updateStandup(standup.id, { timeOffPolicy: 'approval' });
  stack.clock.set('2026-06-10T10:00');
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router, scheduler: stack.scheduler, adapter: stack.adapter, blockers: stack.blockers,
    repo: stack.repo, settings: stack.settings, dashboardToken: OPERATOR, skipVerification: true,
    secretKey: SECRET, service: stack.service, schedule: stack.schedule, now: stack.clock.now,
  });
  const srv = app.listen(0);
  close = () => srv.close();
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const cookieFor = (sub: string, name = sub) => `asyncup_sess=${sealSession(SECRET, newSession({ sub, email: `${sub}@o.com`, name, admin: false }))}`;
  const op = (path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
  const as = (cookie: string, path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, { ...init, headers: { cookie, ...CSRF, ...(init.headers as Record<string, string>) } });
  return { ...stack, standup, url, op, as, cookieFor };
}

describe('API: assigning a reporting manager', () => {
  it('sets, shows, validates and clears a participant reporting manager (criteria 1–4)', async () => {
    const { op, repo, standup } = await server();
    const patch = (who: string, body: unknown) => op(`/standups/${standup.id}/participants/${encodeURIComponent(who)}`, { method: 'PATCH', body: JSON.stringify(body) });

    // candidates are the standup's managers
    const cands = await (await op(`/standups/${standup.id}/manager-candidates`)).json() as any;
    expect(cands.managers).toEqual([{ userName: 'users/alice', displayName: 'Alice' }]);

    // criterion 1: set, and it shows on the row and in the detail
    const set = await (await patch('users/bob', { reportingManager: 'users/alice' })).json() as any;
    expect(set).toMatchObject({ userName: 'users/bob', reportingManager: 'users/alice', reportingManagerName: 'Alice' });
    const detail = await (await op(`/standups/${standup.id}`)).json() as any;
    expect(detail.participants.find((p: any) => p.userName === 'users/bob')).toMatchObject({ reportingManager: 'users/alice', reportingManagerName: 'Alice' });

    // criterion 3: can't report to yourself
    expect((await (await patch('users/alice', { reportingManager: 'users/alice' })).json() as any).error).toMatchObject({ field: 'reportingManager', message: "Someone can't report to themselves." });
    // criterion 2: must already be a manager
    expect((await (await patch('users/bob', { reportingManager: 'users/carol' })).json() as any).error.message).toContain('must already be a manager');
    // a bad type is refused
    expect((await (await patch('users/bob', { reportingManager: 7 })).json() as any).error.field).toBe('reportingManager');
    // criterion 4: clear it
    expect(await (await patch('users/bob', { reportingManager: null })).json() as any).toMatchObject({ reportingManager: null, reportingManagerName: null });
  });
});

describe('API: seeing and deciding requests as a reporting manager', () => {
  it('a reporting manager who manages no standup sees and approves their reports’ days off (criteria 6, 9)', async () => {
    const { as, op, repo, schedule, standup, cookieFor } = await server();
    await repo.setReportingManager(standup.id, 'users/bob', carol); // Carol is not a manager, only Bob's RM
    await schedule.setOverride({ target: bob, dates: ['2026-06-11'], working: false, reason: 'sick', actor: selfActor(bob), channel: 'chat' });

    const carolCookie = cookieFor('carol', 'Carol');
    const seen = await (await as(carolCookie, '/requests')).json() as any;
    expect(seen.requests.map((r: any) => [r.userName, r.date])).toEqual([['users/bob', '2026-06-11']]);

    const id = seen.requests[0].id;
    const approve = await as(carolCookie, `/requests/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
    expect(approve.status).toBe(200);
    expect((await repo.getOverride('users/bob', '2026-06-11'))!.status).toBe('active');

    // Someone who is neither a manager nor a reporting manager is refused.
    expect((await as(cookieFor('dave', 'Dave'), '/requests')).status).toBe(403);
  });

  it('a standup manager still sees every request of the people they manage, days off or working', async () => {
    const { as, repo, schedule, standup, cookieFor } = await server();
    await schedule.setOverride({ target: bob, dates: ['2026-06-11'], working: false, reason: 'sick', actor: selfActor(bob), channel: 'chat' });
    // Alice manages the standup (added as admin in server()), so she sees Bob's request without being his RM.
    const seen = await (await as(cookieFor('alice', 'Alice'), '/requests')).json() as any;
    expect(seen.requests.map((r: any) => r.userName)).toContain('users/bob');
  });
});
