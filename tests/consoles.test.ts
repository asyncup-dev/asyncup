import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import type { IdentityBroker } from '../src/auth/google.js';
import { newSession, openSession, sealSession } from '../src/auth/session.js';
import type { DirectoryUser } from '../src/core/directory.js';
import { createServer } from '../src/server.js';
import { ANSWERS, makeStack, seedStandup, TENANT } from './helpers.js';

const SECRET = 'console-secret-key';
let close: (() => void) | null = null;

function fakeBroker(identity = { sub: '42', email: 'asha@org.com', name: 'Asha' }): IdentityBroker {
  return {
    authUrl: (redirect, state) => `https://accounts.example/auth?state=${state}&redirect=${encodeURIComponent(redirect)}`,
    exchange: async () => identity,
  };
}

async function startServer(opts: { directoryUser?: DirectoryUser | null; broker?: IdentityBroker } = {}) {
  const stack = await makeStack();
  await stack.settings.update({ oauthClientId: 'x.apps.googleusercontent.com', oauthClientSecret: 's' });
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router,
    scheduler: stack.scheduler,
    repo: stack.repo,
    settings: stack.settings,
    dashboardToken: 'dash-secret',
    skipVerification: true,
    secretKey: SECRET,
    directory:
      opts.directoryUser === undefined
        ? async () => null
        : async () => ({ lookup: async () => opts.directoryUser ?? null }),
    identityBroker: () => opts.broker ?? fakeBroker(),
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookieFor = (session: Parameters<typeof sealSession>[1]) =>
    `asyncup_sess=${sealSession(SECRET, session)}`;
  return { ...stack, url, cookieFor };
}

afterEach(() => {
  close?.();
  close = null;
});

describe('Sessions', () => {
  it('round-trips, rejects tampering, rejects expiry', () => {
    const session = newSession({ sub: '42', email: 'a@o.com', name: 'A', admin: true });
    const sealed = sealSession(SECRET, session);
    expect(openSession(SECRET, sealed)).toMatchObject({ sub: '42', admin: true });
    expect(openSession(SECRET, sealed.slice(0, -2) + 'xx')).toBeNull();
    expect(openSession('other-key', sealed)).toBeNull();
    expect(openSession(SECRET, sealSession(SECRET, { ...session, exp: 1 }))).toBeNull();
  });
});

describe('Google sign-in', () => {
  async function completeSignIn(url: string): Promise<{ location: string; cookie: string }> {
    const start = await fetch(`${url}/auth/google`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const stateCookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const cb = await fetch(`${url}/auth/callback?code=c&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: stateCookie },
    });
    expect(cb.status).toBe(302);
    return { location: cb.headers.get('location')!, cookie: cb.headers.get('set-cookie')!.split(';')[0]! };
  }

  it('signs a Workspace admin in and lands them on the admin dashboard', async () => {
    const { url } = await startServer({
      directoryUser: { id: null, email: 'asha@org.com', isAdmin: true, suspended: false },
    });
    const { location, cookie } = await completeSignIn(url);
    expect(location).toBe('/dashboard');
    expect((await fetch(`${url}/dashboard`, { headers: { cookie } })).status).toBe(200);
  });

  it('signs a regular member in and keeps them out of the admin dashboard', async () => {
    const { url } = await startServer({
      directoryUser: { id: null, email: 'asha@org.com', isAdmin: false, suspended: false },
    });
    const { location, cookie } = await completeSignIn(url);
    expect(location).toBe('/me');
    const dash = await fetch(`${url}/dashboard`, { headers: { cookie }, redirect: 'manual' });
    expect(dash.status).toBe(303);
    expect(dash.headers.get('location')).toBe('/me');
  });

  it('rejects accounts the Directory does not know or that are suspended', async () => {
    const { url } = await startServer({ directoryUser: null });
    const start = await fetch(`${url}/auth/google`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cb = await fetch(`${url}/auth/callback?code=c&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: start.headers.get('set-cookie')!.split(';')[0]! },
    });
    expect(cb.status).toBe(403);
  });

  it('rejects a state mismatch', async () => {
    const { url } = await startServer();
    expect((await fetch(`${url}/auth/callback?code=c&state=forged`, { redirect: 'manual' })).status).toBe(400);
  });
});

describe('Dashboard without an operator token', () => {
  it('still serves admin sessions when DASHBOARD_TOKEN is empty', async () => {
    const stack = await makeStack();
    await stack.settings.update({ oauthClientId: 'x.apps.googleusercontent.com', oauthClientSecret: 's' });
    const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
    const app = createServer({
      router,
      scheduler: stack.scheduler,
      repo: stack.repo,
      settings: stack.settings,
      dashboardToken: '', // no break-glass token — sessions must still work
      skipVerification: true,
      secretKey: SECRET,
      now: stack.clock.now,
    });
    const server = app.listen(0);
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const cookie = `asyncup_sess=${sealSession(SECRET, newSession({ sub: '1', email: 'a@o.com', name: 'A', admin: true }))}`;
    expect((await fetch(`${url}/dashboard`, { headers: { cookie } })).status).toBe(200);
    // anonymous visitors get the sign-in page, not a 404
    expect((await fetch(`${url}/dashboard`)).status).toBe(401);
  });
});

describe('User console', () => {
  it('asks anonymous visitors to sign in', async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/me`);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Sign in with Google');
  });

  it('shows the member their standups, today status and history', async () => {
    const { url, repo, service, clock, cookieFor } = await startServer();
    const standup = await seedStandup(repo);
    // "users/42" matches the fake identity sub
    await repo.upsertParticipant({ standupId: standup.id, userName: 'users/42', displayName: 'Asha' });
    const run = await repo.createRun(standup.id, '2026-06-10', 'k');
    await service.submit(run.id, 'users/42', 'Asha', ANSWERS);
    clock.set('2026-06-10T10:00');

    const cookie = cookieFor(newSession({ sub: '42', email: 'asha@org.com', name: 'Asha', admin: false }));
    const page = await (await fetch(`${url}/me`, { headers: { cookie } })).text();
    expect(page).toContain('Daily Standup');
    expect(page).toContain('✅ submitted');
    expect(page).toContain('Shipped the auth refactor');
    expect(page).toContain('Vacation mode');
  });

  it('lets the member set their timezone and vacation state', async () => {
    const { url, repo, cookieFor } = await startServer();
    const standup = await seedStandup(repo);
    await repo.upsertParticipant({ standupId: standup.id, userName: 'users/42', displayName: 'Asha' });
    const cookie = cookieFor(newSession({ sub: '42', email: 'asha@org.com', name: 'Asha', admin: false }));
    const post = (path: string, body: Record<string, string>) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual',
      });

    expect((await post('/me/timezone', { timezone: 'Europe/Berlin' })).status).toBe(302);
    expect((await post('/me/vacation', { state: 'on' })).status).toBe(302);
    const me = (await repo.listParticipants(standup.id)).find((p) => p.userName === 'users/42')!;
    expect(me.timezone).toBe('Europe/Berlin');
    expect(me.onVacation).toBe(true);

    // writes require a session
    expect(
      (
        await fetch(`${url}/me/vacation`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'state=off',
        })
      ).status,
    ).toBe(401);
  });
});
