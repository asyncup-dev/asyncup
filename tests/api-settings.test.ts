import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import type { SamlBroker } from '../src/auth/saml.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const SECRET = 'api-test-secret';
const OPERATOR = 'dash-secret';
const SA_KEY = JSON.stringify({ type: 'service_account', client_email: 'bot@p.iam.gserviceaccount.com', private_key: 'k' });
let close: (() => void) | null = null;

type Fake = { spaces?: number; fail?: string; fetchStatus?: number; fetchThrows?: boolean; brokerThrows?: boolean; realBroker?: boolean; skipVerification?: boolean };

async function startServer(fake: Fake = {}) {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const calls: { fetch: string[] } = { fetch: [] };
  const app = createServer({
    router,
    scheduler: stack.scheduler,
    adapter: stack.adapter,
    blockers: stack.blockers,
    repo: stack.repo,
    settings: stack.settings,
    dashboardToken: OPERATOR,
    skipVerification: fake.skipVerification ?? true,
    secretKey: SECRET,
    webhookSecret: () => 'whsec',
    now: stack.clock.now,
    chatClientFactory: () =>
      ({
        spaces: {
          list: async () => {
            if (fake.fail) throw new Error(fake.fail);
            return { data: { spaces: Array.from({ length: fake.spaces ?? 0 }, (_, i) => ({ name: `spaces/${i}` })) } };
          },
        },
      }) as any,
    samlBroker: fake.realBroker
      ? undefined
      : (): SamlBroker => ({
          loginUrl: async () => {
            if (fake.brokerThrows) throw new Error('bad cert');
            return 'https://idp/sso?SAMLRequest=x';
          },
          consume: async () => null,
          spMetadata: () => '<md/>',
        }),
    externalFetch: (async (url: string | URL | Request) => {
      calls.fetch.push(String(url));
      if (fake.fetchThrows) throw new Error('ECONNREFUSED');
      return new Response('', { status: fake.fetchStatus ?? 200 });
    }) as typeof fetch,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookieFor = (sub: string, admin = false) =>
    `asyncup_sess=${sealSession(SECRET, newSession({ sub, email: `${sub}@o.com`, name: sub, admin }))}`;
  const op = (path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
  const as = (cookie: string, path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, { ...init, headers: { cookie, 'x-requested-with': 'asyncup', 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
  return { ...stack, url, cookieFor, op, as, calls };
}

afterEach(() => {
  close?.();
  close = null;
});

describe('api: settings', () => {
  it('shows settings to admins only, with secrets masked', async () => {
    const { op, as, cookieFor, settings } = await startServer();
    expect((await as(cookieFor('alice'), '/settings')).status).toBe(403);
    await settings.update({ serviceAccountJson: SA_KEY, oauthClientSecret: 'GOCSPX-x', tickToken: 't' });
    const body = await (await op('/settings')).json() as any;
    expect(body.chat.serviceAccount).toEqual({ set: true, email: 'bot@p.iam.gserviceaccount.com' });
    expect(body.signIn.google).toEqual({ clientId: '', clientSecret: { set: true }, on: false });
    expect(body.tokens).toEqual({ tick: { set: true }, export: { set: false }, scim: { set: false } });
    expect(body.setup).toEqual({ complete: false, chatConfigured: false, signInConfigured: false });
    expect(JSON.stringify(body)).not.toContain('GOCSPX');
    await settings.update({ serviceAccountJson: '{"client_email":1}' });
    expect((await (await op('/settings')).json() as any).chat.serviceAccount.email).toBe(1);
    await settings.update({ serviceAccountJson: 'not json' });
    expect((await (await op('/settings')).json() as any).chat.serviceAccount.email).toBeNull();
  });

  it('patches fields with the shared rules and refuses lockouts', async () => {
    const { op, as, cookieFor, settings } = await startServer();
    const patch = (body: unknown, init: RequestInit = {}) => op('/settings', { method: 'PATCH', body: JSON.stringify(body), ...init });
    expect((await as(cookieFor('alice'), '/settings', { method: 'PATCH', body: '{}' })).status).toBe(403);

    const ok = await patch({ chatAudience: ' 728449131907 ', defaultTimezone: 'Europe/Berlin', calendarOoo: false, serviceAccountJson: SA_KEY, setupComplete: true });
    expect(ok.status).toBe(200);
    const s = await settings.get();
    expect(s.chatAudience).toBe('728449131907');
    expect(s.defaultTimezone).toBe('Europe/Berlin');
    expect(s.calendarOoo).toBe(false);
    expect(s.setupComplete).toBe(true);
    expect((await ok.json() as any).setup.chatConfigured).toBe(true);

    for (const [body, field] of [
      [{ chatAudience: 'my-project-slug' }, 'chatAudience'],
      [{ calendarOoo: 'no' }, 'calendarOoo'],
      [{ tokenSignIn: false }, 'tokenSignIn'],
      [{ nonsense: 'x' }, 'nonsense'],
      [{ constructor: 'x' }, 'constructor'],
      [{ serviceAccountJson: '{}' }, 'serviceAccountJson'],
    ] as const) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect((await res.json() as any).error.field).toBe(field);
    }

    // JSON.parse makes __proto__ an own key; a literal would not.
    const proto = await patch(undefined, { body: '{"__proto__":"x"}' });
    expect(proto.status).toBe(400);
    expect((await proto.json() as any).error.field).toBe('__proto__');

    // Secrets: empty keeps, null clears.
    await patch({ serviceAccountJson: '' });
    expect((await settings.get()).serviceAccountJson).toBe(SA_KEY);
    await patch({ serviceAccountJson: null });
    expect((await settings.get()).serviceAccountJson).toBe('');

    // Turning the token off once Google sign-in works is fine — and it disables the operator bearer,
    // so the follow-up runs as an admin session. Removing Google afterwards is a lockout.
    await patch({ oauthClientId: 'x.apps.googleusercontent.com', oauthClientSecret: 'GOCSPX-1' });
    expect((await patch({ tokenSignIn: false })).status).toBe(200);
    const admin = cookieFor('root', true);
    const locked = await as(admin, '/settings', { method: 'PATCH', body: JSON.stringify({ oauthClientSecret: null }) });
    expect(locked.status).toBe(409);
    expect((await locked.json() as any).error.code).toBe('lockout');
    expect((await settings.get()).oauthClientSecret).toBe('GOCSPX-1');
    expect((await as(admin, '/settings', { method: 'PATCH', body: '{}' })).status).toBe(200);
    expect((await as(admin, '/settings', { method: 'PATCH', body: '"not an object"' })).status).toBe(400);
  });

  it('generates and clears machine tokens', async () => {
    const { op, as, cookieFor, settings } = await startServer();
    expect((await as(cookieFor('alice'), '/settings/tokens/tick', { method: 'POST' })).status).toBe(403);
    expect((await as(cookieFor('alice'), '/settings/tokens/tick', { method: 'DELETE' })).status).toBe(403);
    expect((await op('/settings/tokens/nope', { method: 'POST' })).status).toBe(404);
    expect((await op('/settings/tokens/nope', { method: 'DELETE' })).status).toBe(404);
    const created = await op('/settings/tokens/export', { method: 'POST' });
    expect(created.status).toBe(201);
    const { name, token } = await created.json() as any;
    expect(name).toBe('export');
    expect((await settings.get()).exportToken).toBe(token);
    expect((await op('/settings/tokens/export', { method: 'DELETE' })).status).toBe(204);
    expect((await settings.get()).exportToken).toBe('');
  });
});

describe('api: verification', () => {
  it('checks the project audience', async () => {
    const { op, settings } = await startServer();
    const verify = () => op('/verify/project', { method: 'POST' });
    expect((await (await verify()).json() as any).state).toBe('fail');
    await settings.update({ chatAudience: '123 https://app.example/chat/events' });
    const ok = await (await verify()).json() as any;
    expect(ok.state).toBe('pass');
    expect(ok.data.audiences).toEqual(['123', 'https://app.example/chat/events']);
    await settings.update({ chatAudience: 'slug-not-number' });
    expect((await (await verify()).json() as any).state).toBe('fail');
  });

  it('checks the service-account key against the Chat API', async () => {
    const none = await startServer();
    expect((await (await none.op('/verify/service-account', { method: 'POST' })).json() as any).detail).toContain('No service-account key');
    close?.();

    const empty = await startServer({ spaces: 0 });
    await empty.settings.update({ serviceAccountJson: SA_KEY });
    let r = await (await empty.op('/verify/service-account', { method: 'POST' })).json() as any;
    expect(r).toMatchObject({ state: 'pass', data: { email: 'bot@p.iam.gserviceaccount.com', spaces: 0 } });
    expect(r.detail).toContain('Add the app to a space');
    close?.();

    const some = await startServer({ spaces: 2 });
    await some.settings.update({ serviceAccountJson: SA_KEY });
    r = await (await some.op('/verify/service-account', { method: 'POST' })).json() as any;
    expect(r.data.spaces).toBe(2);
    expect(r.detail).toContain('already in at least one space');
    close?.();

    const broken = await startServer({ fail: 'invalid_grant' });
    await broken.settings.update({ serviceAccountJson: SA_KEY });
    r = await (await broken.op('/verify/service-account', { method: 'POST' })).json() as any;
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('invalid_grant');
    expect(r.detail).toContain('bot@p.iam.gserviceaccount.com');
  });

  it('reports whether a verified Chat event has arrived, and exposes /health/chat', async () => {
    const strict = await startServer({ skipVerification: false });
    await strict.settings.update({ chatAudience: '123' });
    const verify = () => strict.op('/verify/chat-event', { method: 'POST' });
    expect((await (await verify()).json() as any).detail).toContain('No event received yet');

    // An unsigned event is rejected and recorded as such.
    expect((await fetch(`${strict.url}/chat/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"MESSAGE"}' })).status).toBe(401);
    let r = await (await verify()).json() as any;
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('failed verification');
    let health = await (await fetch(`${strict.url}/health/chat`)).json() as any;
    expect(health).toMatchObject({ audience: 'set', serviceAccount: 'unset', lastEventAt: null });
    expect(health.lastRejectedAt).toEqual(expect.any(String));
    close?.();

    const open = await startServer();
    expect((await fetch(`${open.url}/chat/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'ADDED_TO_SPACE', space: { name: 'spaces/x', displayName: 'X' } }) })).status).toBe(200);
    r = await (await open.op('/verify/chat-event', { method: 'POST' })).json() as any;
    expect(r.state).toBe('pass');
    expect(r.data.lastEventAt).toEqual(expect.any(String));
    health = await (await fetch(`${open.url}/health/chat`)).json() as any;
    expect(health.lastEventAt).toEqual(expect.any(String));
  });

  it('sends a signed test event to a standup webhook', async () => {
    const t = await startServer({ fetchStatus: 204 });
    const s = await seedStandup(t.repo);
    const verify = (standupId: number) => t.op('/verify/webhook', { method: 'POST', body: JSON.stringify({ standupId }) });
    expect((await verify(999)).status).toBe(404);
    expect((await (await verify(s.id)).json() as any).detail).toContain('no webhook URL');
    await t.repo.updateStandup(s.id, { webhookUrl: 'https://hooks.example/x' });
    const ok = await (await verify(s.id)).json() as any;
    expect(ok).toMatchObject({ state: 'pass', data: { status: 204 } });
    expect(t.calls.fetch).toEqual(['https://hooks.example/x']);
    close?.();

    const bad = await startServer({ fetchStatus: 500 });
    const s2 = await seedStandup(bad.repo);
    await bad.repo.updateStandup(s2.id, { webhookUrl: 'https://hooks.example/x' });
    expect((await (await bad.op('/verify/webhook', { method: 'POST', body: JSON.stringify({ standupId: s2.id }) })).json() as any).detail).toContain('HTTP 500');
    close?.();

    const down = await startServer({ fetchThrows: true });
    const s3 = await seedStandup(down.repo);
    await down.repo.updateStandup(s3.id, { webhookUrl: 'https://hooks.example/x' });
    expect((await (await down.op('/verify/webhook', { method: 'POST', body: JSON.stringify({ standupId: s3.id }) })).json() as any).detail).toContain('ECONNREFUSED');
  });

  it('checks the SAML configuration and IdP reachability', async () => {
    const SAML = { samlIdpEntityId: 'https://idp', samlIdpSsoUrl: 'https://idp/sso', samlIdpCert: 'MIICfake==' };
    const t = await startServer();
    const verify = () => t.op('/verify/saml', { method: 'POST' });
    expect((await (await verify()).json() as any).detail).toContain('needs the IdP entity ID');
    await t.settings.update(SAML);
    const ok = await (await verify()).json() as any;
    expect(ok).toMatchObject({ state: 'pass', data: { status: 200 } });
    expect(t.calls.fetch).toEqual(['https://idp/sso']);
    close?.();

    const broken = await startServer({ brokerThrows: true });
    await broken.settings.update(SAML);
    expect((await (await broken.op('/verify/saml', { method: 'POST' })).json() as any).detail).toContain('bad cert');
    close?.();

    const err = await startServer({ fetchStatus: 503 });
    await err.settings.update(SAML);
    expect((await (await err.op('/verify/saml', { method: 'POST' })).json() as any).detail).toContain('answered 503');
    close?.();

    const down = await startServer({ fetchThrows: true });
    await down.settings.update(SAML);
    expect((await (await down.op('/verify/saml', { method: 'POST' })).json() as any).detail).toContain('not reachable');
    close?.();

    // The real node-saml broker builds the request; only the IdP round-trip is faked.
    const real = await startServer({ realBroker: true });
    await real.settings.update(SAML);
    expect((await (await real.op('/verify/saml', { method: 'POST' })).json() as any).state).toBe('pass');
    expect(real.calls.fetch).toEqual(['https://idp/sso']);
  });

  it('DMs the signed-in person, never the operator token', async () => {
    const { op, as, cookieFor, adapter } = await startServer();
    expect((await (await op('/verify/dm', { method: 'POST' })).json() as any).error.code).toBe('needs_user');
    const alice = cookieFor('alice');
    expect((await (await as(alice, '/verify/dm', { method: 'POST' })).json() as any).state).toBe('pass');
    expect(adapter.dms.at(-1)).toMatchObject({ kind: 'text', userName: 'users/alice' });
    adapter.sendDm = async () => {
      throw new Error('no DM space');
    };
    const failed = await (await as(alice, '/verify/dm', { method: 'POST' })).json() as any;
    expect(failed.state).toBe('fail');
    expect(failed.detail).toContain('no DM space');
  });

  it('keeps the other verification gates admin-only', async () => {
    const { as, cookieFor } = await startServer();
    for (const path of ['/verify/project', '/verify/service-account', '/verify/chat-event', '/verify/saml']) {
      expect((await as(cookieFor('alice'), path, { method: 'POST' })).status).toBe(403);
    }
  });
});
