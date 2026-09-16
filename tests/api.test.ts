import type { AddressInfo } from 'node:net';
import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { createServer } from '../src/server.js';
import { ANSWERS, makeStack, seedStandup, TENANT } from './helpers.js';

const SECRET = 'api-test-secret';
const OPERATOR = 'dash-secret';
let close: (() => void) | null = null;

async function startServer(opts: { secretKey?: string; tenantId?: string; realClock?: boolean } = {}) {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router,
    scheduler: stack.scheduler,
    repo: stack.repo,
    settings: stack.settings,
    dashboardToken: OPERATOR,
    skipVerification: true,
    secretKey: opts.secretKey ?? SECRET,
    tenantId: opts.tenantId,
    now: opts.realClock ? undefined : stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookieFor = (sub: string, email: string, admin = false) =>
    `asyncup_sess=${sealSession(SECRET, newSession({ sub, email, name: email.split('@')[0]!, admin }))}`;
  const call = (path: string, init: RequestInit = {}) => fetch(`${url}/api/v1${path}`, init);
  const asCookie = (cookie: string, path: string, init: RequestInit = {}) =>
    call(path, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });
  const asBearer = (token: string, path: string, init: RequestInit = {}) =>
    call(path, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
  return { ...stack, url, cookieFor, call, asCookie, asBearer };
}

afterEach(() => {
  close?.();
  close = null;
});

describe('api: authentication', () => {
  it('rejects anonymous and bad-token calls with the JSON envelope', async () => {
    const { call, asBearer, settings } = await startServer();
    const anon = await call('/me');
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toBe('Bearer');
    expect(await anon.json() as any).toEqual({ error: { code: 'unauthenticated', message: 'Sign in, or send a bearer token.' } });

    const bad = await asBearer('nope', '/me');
    expect(bad.status).toBe(401);
    expect((await bad.json() as any).error.code).toBe('bad_token');

    // The operator token stops working once token sign-in is switched off.
    await settings.update({ tokenSignIn: false });
    expect((await asBearer(OPERATOR, '/me')).status).toBe(401);
  });

  it('ignores session cookies when no secret key is configured', async () => {
    const { asCookie, cookieFor } = await startServer({ secretKey: '' });
    expect((await asCookie(cookieFor('1', 'a@o.com', true), '/me')).status).toBe(401);
  });

  it('resolves the operator token as a token-backed admin', async () => {
    const { asBearer } = await startServer();
    const res = await asBearer(OPERATOR, '/me');
    expect(res.status).toBe(200);
    expect(await res.json() as any).toEqual({ kind: 'admin', via: 'token', tenantId: 'default', user: null, managedStandupIds: [] });
  });

  it('derives admin, manager and member from the session', async () => {
    const { asCookie, cookieFor, repo } = await startServer();
    const standup = await seedStandup(repo);

    const admin = await (await asCookie(cookieFor('1', 'asha@o.com', true), '/me')).json() as any;
    expect(admin).toMatchObject({ kind: 'admin', via: 'session', user: { userName: 'users/1', email: 'asha@o.com' } });

    const member = await (await asCookie(cookieFor('alice', 'alice@o.com'), '/me')).json() as any;
    expect(member).toMatchObject({ kind: 'member', user: { userName: 'users/alice' }, managedStandupIds: [] });

    await repo.addAdmin(standup.id, 'users/alice', 'Alice');
    const manager = await (await asCookie(cookieFor('alice', 'alice@o.com'), '/me')).json() as any;
    expect(manager).toMatchObject({ kind: 'manager', managedStandupIds: [standup.id] });
  });

  it('links SAML sessions (email only) through the cached email map', async () => {
    const { asCookie, cookieFor, repo } = await startServer();
    await seedStandup(repo);
    const unlinked = await (await asCookie(cookieFor('', 'bob@o.com'), '/me')).json() as any;
    expect(unlinked.user.userName).toBeNull();
    expect((await (await asCookie(cookieFor('', 'bob@o.com'), '/standups')).json() as any).standups).toEqual([]);

    await repo.setUserEmail('users/bob', 'bob@o.com');
    const linked = await (await asCookie(cookieFor('', 'bob@o.com'), '/me')).json() as any;
    expect(linked.user.userName).toBe('users/bob');
    expect((await (await asCookie(cookieFor('', 'bob@o.com'), '/standups')).json() as any).standups).toHaveLength(1);
  });

  it('requires the CSRF header on state-changing browser requests, never on tokens', async () => {
    const { asCookie, asBearer, cookieFor } = await startServer();
    const cookie = cookieFor('alice', 'alice@o.com');
    const blocked = await asCookie(cookie, '/standups', { method: 'POST' });
    expect(blocked.status).toBe(403);
    expect((await blocked.json() as any).error.code).toBe('csrf');
    // With the header the request reaches routing — and there is no POST route yet.
    const routed = await asCookie(cookie, '/standups', { method: 'POST', headers: { 'x-requested-with': 'asyncup' } });
    expect(routed.status).toBe(404);
    expect((await asBearer(OPERATOR, '/standups', { method: 'POST' })).status).toBe(404);
  });

  it('answers unknown routes with JSON, not HTML', async () => {
    const { asBearer } = await startServer();
    const res = await asBearer(OPERATOR, '/nope');
    expect(res.status).toBe(404);
    expect(await res.json() as any).toEqual({ error: { code: 'not_found', message: 'No such API route.' } });
  });
});

describe('api: standups', () => {
  it('uses the real clock when none is injected', async () => {
    const { asBearer, repo } = await startServer({ realClock: true });
    const standup = await seedStandup(repo);
    const body = await (await asBearer(OPERATOR, '/standups')).json() as any;
    expect(body.standups[0].today.date).toBe(DateTime.utc().setZone(standup.timezone).toISODate());
  });

  it('lists the tenant for admins with today’s progress and permissions', async () => {
    const { asBearer, repo, scheduler, service, clock } = await startServer();
    const standup = await seedStandup(repo);
    await repo.updateStandup(standup.id, { webhookUrl: 'https://hooks.example/x', escalateUserName: 'users/bob', escalateDisplayName: 'Bob' });
    await repo.createStandup({ tenantId: 'other-tenant', spaceName: 'spaces/elsewhere', name: 'Not ours', timezone: 'UTC' });

    // Before any run: today is null
    let body = await (await asBearer(OPERATOR, '/standups')).json() as any;
    expect(body.standups).toHaveLength(1);
    expect(body.standups[0]).toMatchObject({
      id: standup.id,
      name: 'Daily Standup',
      schedule: { promptTime: '09:30', deadlineTime: '11:30', timezone: 'Asia/Kolkata', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
      people: { total: 3, mandatory: 2 },
      webhook: { configured: true },
      escalation: { afterDays: 2, contact: { userName: 'users/bob', displayName: 'Bob' } },
      today: { status: null, submitted: 0, expected: 0, missing: [] },
      permissions: { manage: true },
    });
    expect(body.standups[0].questions).toHaveLength(3);

    // Open today's run and submit as Alice: Bob is the one mandatory person missing.
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    body = await (await asBearer(OPERATOR, '/standups')).json() as any;
    expect(body.standups[0].today).toEqual({
      date: '2026-06-10',
      status: 'open',
      submitted: 1,
      expected: 3,
      missing: [{ userName: 'users/bob', displayName: 'Bob' }],
    });
  });

  it('scopes the list to membership for members and to administration for managers', async () => {
    const { asCookie, cookieFor, repo } = await startServer();
    const mine = await seedStandup(repo);
    const theirs = await repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/other', name: 'Other team', timezone: 'UTC' });
    await repo.upsertParticipant({ standupId: theirs.id, userName: 'users/dave', displayName: 'Dave' });

    const alice = cookieFor('alice', 'alice@o.com');
    let body = await (await asCookie(alice, '/standups')).json() as any;
    expect(body.standups.map((s: any) => [s.id, s.permissions.manage])).toEqual([[mine.id, false]]);

    // Managing the other standup adds it, with manage rights, without joining it.
    await repo.addAdmin(theirs.id, 'users/alice', 'Alice');
    body = await (await asCookie(alice, '/standups')).json() as any;
    expect(body.standups.map((s: any) => [s.id, s.permissions.manage])).toEqual([
      [mine.id, false],
      [theirs.id, true],
    ]);
  });

  it('serves standup detail with roster and admins, and hides what the caller may not see', async () => {
    const { asBearer, asCookie, cookieFor, repo } = await startServer();
    const standup = await seedStandup(repo);
    await repo.addAdmin(standup.id, 'users/alice', 'Alice');
    const foreign = await repo.createStandup({ tenantId: 'other-tenant', spaceName: 'spaces/f', name: 'Foreign', timezone: 'UTC' });
    const private_ = await repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/p', name: 'Private', timezone: 'UTC' });

    const detail = await (await asBearer(OPERATOR, `/standups/${standup.id}`)).json() as any;
    expect(detail.participants).toEqual([
      { userName: 'users/alice', displayName: 'Alice', mandatory: true, timezone: null, onVacation: false },
      { userName: 'users/bob', displayName: 'Bob', mandatory: true, timezone: null, onVacation: false },
      { userName: 'users/carol', displayName: 'Carol', mandatory: false, timezone: null, onVacation: false },
    ]);
    expect(detail.admins).toEqual([{ userName: 'users/alice', displayName: 'Alice' }]);
    expect(detail.permissions.manage).toBe(true);

    expect((await asBearer(OPERATOR, '/standups/999')).status).toBe(404);
    expect((await asBearer(OPERATOR, `/standups/${foreign.id}`)).status).toBe(404);

    const bob = cookieFor('bob', 'bob@o.com');
    expect((await asCookie(bob, `/standups/${standup.id}`)).status).toBe(200);
    expect((await (await asCookie(bob, `/standups/${standup.id}`)).json() as any).permissions.manage).toBe(false);
    expect((await asCookie(bob, `/standups/${private_.id}`)).status).toBe(404);
    expect((await asCookie(cookieFor('', 'nobody@o.com'), `/standups/${standup.id}`)).status).toBe(404);
  });
});
