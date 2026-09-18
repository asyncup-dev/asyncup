import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const SECRET = 'api-test-secret';
const OPERATOR = 'dash-secret';
const CSRF = { 'x-requested-with': 'asyncup', 'content-type': 'application/json' };
let close: (() => void) | null = null;
afterEach(() => close?.());

async function startServer(withSchedule = true) {
  const stack = await makeStack();
  const standup = await seedStandup(stack.repo);
  stack.clock.set('2026-06-10T10:00'); // Wednesday
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router,
    scheduler: stack.scheduler,
    adapter: stack.adapter,
    blockers: stack.blockers,
    repo: stack.repo,
    settings: stack.settings,
    dashboardToken: OPERATOR,
    skipVerification: true,
    secretKey: SECRET,
    service: stack.service,
    schedule: withSchedule ? stack.schedule : undefined,
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookieFor = (sub: string, name = sub, admin = false) => `asyncup_sess=${sealSession(SECRET, newSession({ sub, email: `${sub}@o.com`, name, admin }))}`;
  const op = (path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
  const as = (cookie: string, path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, { ...init, headers: { cookie, ...CSRF, ...(init.headers as Record<string, string>) } });
  const json = (body: unknown) => JSON.stringify(body);
  return { ...stack, standup, url, cookieFor, op, as, json };
}

describe('schedule API — the caller’s own schedule', () => {
  it('reads, sets and clears the personal week and days off', async () => {
    const { as, cookieFor, json, repo } = await startServer();
    const alice = cookieFor('alice', 'Alice');
    let res = await as(alice, '/me/schedule');
    expect(await res.json()).toMatchObject({ userName: 'users/alice', workingDays: null, workingDaysLabel: 'Follows the standup', overrides: [], policies: [{ name: 'Daily Standup', timeOffPolicy: 'self' }] });

    res = await as(alice, '/me/schedule', { method: 'PATCH', body: json({ workingDays: 'mon-thu' }) });
    expect(await res.json()).toMatchObject({ workingDays: 'mon,tue,wed,thu', workingDaysLabel: 'Mon–Thu' });
    expect((await (await as(alice, '/me/schedule', { method: 'PATCH', body: json({ workingDays: 'nope' }) })).json()) as any).toMatchObject({ error: { code: 'invalid', field: 'workingDays' } });

    res = await as(alice, '/me/overrides', { method: 'POST', body: json({ from: '2026-06-22', to: '2026-06-23', reason: 'sick' }) });
    expect(await res.json()).toMatchObject({ ok: true, status: 'active', message: expect.stringContaining('Mon 22 Jun – Tue 23 Jun marked off (sick)') });
    res = await as(alice, '/me/overrides', { method: 'POST', body: json({ date: '2026-06-13', working: true }) });
    expect(res.status).toBe(200);
    const view: any = await (await as(alice, '/me/schedule')).json();
    expect(view.overrides.map((o: any) => [o.date, o.label, o.status, o.setBy, o.channel])).toEqual([
      ['2026-06-13', 'Working', 'active', 'Alice', 'console'],
      ['2026-06-22', 'Day off', 'active', 'Alice', 'console'],
      ['2026-06-23', 'Day off', 'active', 'Alice', 'console'],
    ]);
    res = await as(alice, '/me/overrides/2026-06-23', { method: 'DELETE' });
    expect(await res.json()).toMatchObject({ ok: true });
    expect((await repo.getOverride('users/alice', '2026-06-23'))!.status).toBe('withdrawn');

    // refusals surface as 403 with the service's explanation
    res = await as(alice, '/me/overrides', { method: 'POST', body: json({ date: '2026-06-01' }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'refused', message: 'Past days can only be changed by a manager.' } });
    res = await as(alice, '/me/overrides/2026-06-01', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('validates the date inputs', async () => {
    const { as, cookieFor, json } = await startServer();
    const alice = cookieFor('alice', 'Alice');
    for (const body of [{}, { date: 'tomorrow' }, { dates: ['2026-06-12', 'x'] }, { from: '2026-06-12', to: '2026-06-11' }, { from: 'x', to: '2026-06-11' }]) {
      const res = await as(alice, '/me/overrides', { method: 'POST', body: json(body) });
      expect(res.status).toBe(400);
    }
    const long = await as(alice, '/me/overrides', { method: 'POST', body: json({ from: '2026-06-12', to: '2026-08-12' }) });
    expect(await long.json()).toMatchObject({ error: { message: 'At most 31 days at a time.' } });
    const dup = await as(alice, '/me/overrides', { method: 'POST', body: json({ dates: ['2026-06-12', '2026-06-12'], reason: 'x'.repeat(300) }) });
    expect(dup.status).toBe(200);
  });

  it('needs a linked Chat identity and a schedule service', async () => {
    const { as, cookieFor, json, op } = await startServer();
    const unlinked = cookieFor('', 'Nobody');
    for (const [path, init] of [
      ['/me/schedule', {}],
      ['/me/schedule', { method: 'PATCH', body: json({ workingDays: 'mon' }) }],
      ['/me/overrides', { method: 'POST', body: json({ date: '2026-06-12' }) }],
      ['/me/overrides/2026-06-12', { method: 'DELETE' }],
    ] as const) {
      expect((await as(unlinked, path, init as RequestInit)).status).toBe(409);
    }
    expect((await op('/me/schedule')).status).toBe(409); // the operator token is not a person

    close?.();
    const bare = await startServer(false);
    for (const path of ['/me/schedule', '/people/users%2Falice/schedule', '/requests']) expect((await bare.op(path)).status).toBe(503);
    expect((await bare.as(bare.cookieFor('alice'), '/me/schedule', { method: 'PATCH', body: bare.json({}) })).status).toBe(503);
    expect((await bare.as(bare.cookieFor('alice'), '/me/overrides', { method: 'POST', body: bare.json({}) })).status).toBe(503);
    expect((await bare.as(bare.cookieFor('alice'), '/me/overrides/2026-06-12', { method: 'DELETE' })).status).toBe(503);
    expect((await bare.op('/people/users%2Falice/schedule', { method: 'PATCH', body: bare.json({}) })).status).toBe(503);
    expect((await bare.op('/people/users%2Falice/overrides', { method: 'POST', body: bare.json({}) })).status).toBe(503);
    expect((await bare.op('/people/users%2Falice/overrides/2026-06-12', { method: 'DELETE' })).status).toBe(503);
    expect((await bare.op('/requests/1/approve', { method: 'POST' })).status).toBe(503);
  });
});

describe('schedule API — managers and admins', () => {
  it('lets the operator and a manager edit someone else’s schedule, but not a plain member', async () => {
    const { as, op, cookieFor, json, repo, standup, adapter } = await startServer();
    await repo.addAdmin(standup.id, 'users/mgr', 'Manager');
    const mgr = cookieFor('mgr', 'Manager');
    const bob = cookieFor('bob', 'Bob');

    let res = await op('/people/users%2Falice/schedule');
    expect(await res.json()).toMatchObject({ userName: 'users/alice', displayName: 'Alice', workingDaysLabel: 'Follows the standup' });
    res = await as(mgr, '/people/users%2Falice/schedule', { method: 'PATCH', body: json({ workingDays: 'tue-sat' }) });
    expect(await res.json()).toMatchObject({ workingDays: 'tue,wed,thu,fri,sat' });
    expect(adapter.dms.at(-1)).toMatchObject({ userName: 'users/alice', text: expect.stringContaining('Manager set your week') });
    res = await as(mgr, '/people/users%2Falice/schedule', { method: 'PATCH', body: json({ workingDays: '???' }) });
    expect(res.status).toBe(400);
    res = await op('/people/users%2Falice/overrides', { method: 'POST', body: json({ date: '2026-06-09', reason: 'sick' }) });
    expect(await res.json()).toMatchObject({ ok: true, message: expect.stringContaining('Tue 9 Jun marked off (sick)') });
    expect(adapter.dms.at(-1)).toMatchObject({ userName: 'users/alice', text: expect.stringContaining('Operator marked you *away*') });
    res = await op('/people/users%2Falice/overrides', { method: 'POST', body: json({}) });
    expect(res.status).toBe(400);
    res = await as(mgr, '/people/users%2Falice/overrides/2026-06-09', { method: 'DELETE' });
    expect(await res.json()).toMatchObject({ ok: true });
    res = await as(mgr, '/people/users%2Falice/overrides/2026-06-09', { method: 'DELETE' });
    expect(res.status).toBe(403);

    for (const [path, init] of [
      ['/people/users%2Falice/schedule', {}],
      ['/people/users%2Falice/schedule', { method: 'PATCH', body: json({ workingDays: 'mon' }) }],
      ['/people/users%2Falice/overrides', { method: 'POST', body: json({ date: '2026-06-12' }) }],
      ['/people/users%2Falice/overrides/2026-06-12', { method: 'DELETE' }],
    ] as const) {
      expect((await as(bob, path, init as RequestInit)).status).toBe(403);
    }
    // someone on no roster still gets a schedule view (empty) for an admin
    expect((await op('/people/users%2Fzed/schedule')).status).toBe(200);
  });

  it('lists and decides pending requests according to role', async () => {
    const { as, op, cookieFor, json, repo, standup, schedule, adapter } = await startServer();
    await repo.updateStandup(standup.id, { timeOffPolicy: 'approval' });
    await repo.addAdmin(standup.id, 'users/mgr', 'Manager');
    const other = await repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/other', name: 'Other', timezone: 'UTC' });
    await repo.upsertParticipant({ standupId: other.id, userName: 'users/dan', displayName: 'Dan' });
    await repo.updateStandup(other.id, { timeOffPolicy: 'approval' });
    await repo.addAdmin(other.id, 'users/ops', 'Ops');
    const self = (m: { userName: string; displayName: string }) => ({ ...m, self: true, manager: false });
    await schedule.setOverride({ target: { userName: 'users/alice', displayName: 'Alice' }, dates: ['2026-06-22', '2026-06-23'], working: false, reason: 'sick', actor: self({ userName: 'users/alice', displayName: 'Alice' }), channel: 'chat' });
    await schedule.setOverride({ target: { userName: 'users/dan', displayName: 'Dan' }, dates: ['2026-06-24'], working: true, reason: '', actor: self({ userName: 'users/dan', displayName: 'Dan' }), channel: 'chat' });

    const mgr = cookieFor('mgr', 'Manager');
    const all: any = await (await op('/requests')).json();
    expect(all.requests.map((r: any) => [r.displayName, r.date, r.status])).toEqual([['Alice', '2026-06-22', 'pending'], ['Alice', '2026-06-23', 'pending'], ['Dan', '2026-06-24', 'pending']]);
    const mine: any = await (await as(mgr, '/requests')).json();
    expect(mine.requests.map((r: any) => r.displayName)).toEqual(['Alice', 'Alice']);
    expect((await as(cookieFor('bob', 'Bob'), '/requests')).status).toBe(403);
    expect((await as(cookieFor('bob', 'Bob'), '/requests/1/approve', { method: 'POST' })).status).toBe(403);

    const ids = mine.requests.map((r: any) => r.id).join(',');
    let res = await as(mgr, `/requests/${ids}/decline`, { method: 'POST', body: json({ note: 'not this week' }) });
    expect(await res.json()).toEqual({ ok: true, message: '❌ Declined — Alice has been told.' });
    expect(adapter.dms.at(-1)).toMatchObject({ userName: 'users/alice', text: expect.stringContaining('“not this week”') });
    res = await as(mgr, `/requests/${ids}/approve`, { method: 'POST' });
    expect(res.status).toBe(409);
    // a manager of another standup cannot decide Dan's request; the operator can
    const dan = all.requests[2].id;
    expect((await as(mgr, `/requests/${dan}/approve`, { method: 'POST' })).status).toBe(409);
    res = await op(`/requests/${dan}/approve`, { method: 'POST', body: json({}) });
    expect(await res.json()).toEqual({ ok: true, message: '✅ Approved — Dan has been told.' });
    expect((await repo.getOverride('users/dan', '2026-06-24'))!).toMatchObject({ status: 'active', decidedByDisplayName: 'Operator' });
  });

  it('exposes away reasons on today’s run, weeks on the team list, and the policy on the standup', async () => {
    const { op, json, repo, standup, schedule, scheduler } = await startServer();
    await repo.setWorkingDaysForUser('users/alice', 'mon,tue');
    await schedule.setOverride({ target: { userName: 'users/bob', displayName: 'Bob' }, dates: ['2026-06-10'], working: false, reason: 'dentist', actor: { userName: 'users/bob', displayName: 'Bob', self: true, manager: false }, channel: 'chat' });
    await scheduler.tick();
    const today: any = await (await op(`/standups/${standup.id}/runs/today`)).json();
    expect(today.away.map((a: any) => [a.displayName, a.reason, a.reasonLabel])).toEqual([['Alice', 'off_day', 'Not a working day'], ['Bob', 'day_off', 'Day off']]);
    expect(today.expected).toBe(1);
    const people: any = await (await op('/people')).json();
    expect(people.people.find((p: any) => p.userName === 'users/alice')).toMatchObject({ workingDays: 'mon,tue', workingDaysLabel: 'Mon, Tue' });
    let res = await op(`/standups/${standup.id}`, { method: 'PATCH', body: json({ timeOffPolicy: 'approval' }) });
    expect(res.status).toBe(200);
    expect((await repo.getStandupById(standup.id))!.timeOffPolicy).toBe('approval');
    res = await op(`/standups/${standup.id}`, { method: 'PATCH', body: json({ timeOffPolicy: 'whenever' }) });
    expect(await res.json()).toMatchObject({ error: { field: 'timeOffPolicy', message: 'Time-off policy must be self, approval or managers.' } });
  });
});
