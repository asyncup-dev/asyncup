import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { ChatRequestVerifier } from '../src/adapters/gchat/auth.js';
import { EventRouter } from '../src/adapters/gchat/events.js';
import type { IdentityBroker } from '../src/auth/google.js';
import type { SamlBroker } from '../src/auth/saml.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const SECRET = 'server-more-secret';
let close: (() => void) | null = null;

const identityBroker: IdentityBroker = {
  authUrl: (redirect, state) => `https://accounts.example/auth?state=${state}&redirect=${encodeURIComponent(redirect)}`,
  exchange: async () => ({ sub: '42', email: 'asha@org.com', name: 'Asha' }),
};

const samlBroker: SamlBroker = {
  loginUrl: async (relay) => `https://idp.example/sso?relay=${relay}`,
  consume: async () => ({ nameId: 'asha@org.com', email: 'asha@org.com', displayName: 'Asha', attributes: {} }),
  spMetadata: () => '<EntityDescriptor>sp</EntityDescriptor>',
};

async function startServer(opts: { verify?: boolean; injectClock?: boolean } = {}) {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router,
    scheduler: stack.scheduler,
    repo: stack.repo,
    adapter: stack.adapter,
    blockers: stack.blockers,
    settings: stack.settings,
    dashboardToken: 'dash-secret',
    skipVerification: !opts.verify,
    secretKey: SECRET,
    identityBroker: () => identityBroker,
    samlBroker: () => samlBroker,
    ...(opts.injectClock === false ? {} : { now: stack.clock.now }),
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const event = (body: object, authorization?: string) =>
    fetch(`${url}/chat/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
    });
  return { ...stack, router, url, event };
}

afterEach(() => {
  close?.();
  close = null;
});

const SETUP_EVENT = {
  type: 'MESSAGE',
  space: { name: 'spaces/team', type: 'ROOM' },
  message: { argumentText: ' setup Crew' },
  user: { name: 'users/admin', displayName: 'Admin' },
};

describe('server edge cases', () => {
  it('reports an unhealthy database on /healthz', async () => {
    const { url, repo } = await startServer();
    const ping = spyOn(repo, 'ping').mockRejectedValue(new Error('down'));
    try {
      const res = await fetch(`${url}/healthz`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false });
    } finally {
      ping.mockRestore();
    }
  });

  it('processes Chat events once the bearer token verifies', async () => {
    const { url, settings, repo } = await startServer({ verify: true });
    await settings.update({ chatAudience: '742900314218' });
    const verify = spyOn(ChatRequestVerifier.prototype, 'verify').mockResolvedValue({ ok: true, aud: '742900314218' });
    try {
      const res = await fetch(`${url}/chat/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer signed-by-google' },
        body: JSON.stringify(SETUP_EVENT),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).text).toContain('Crew');
      expect(verify).toHaveBeenCalledWith('Bearer signed-by-google');
      expect(await repo.listStandupsBySpace(TENANT, 'spaces/team')).toHaveLength(1);
    } finally {
      verify.mockRestore();
    }
  });

  it('answers a crashing event handler with the generic error reply', async () => {
    const { router, event } = await startServer();
    const handle = spyOn(router, 'handle').mockRejectedValue(new Error('boom'));
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const plain: any = await (await event(SETUP_EVENT)).json();
      expect(plain.text).toContain('Something went wrong');

      const dialog: any = await (await event({ ...SETUP_EVENT, type: 'CARD_CLICKED', isDialogEvent: true })).json();
      expect(dialog.actionResponse?.type).toBe('DIALOG');
      expect(dialog.text).toBeUndefined();
      expect(error).toHaveBeenCalled();
    } finally {
      handle.mockRestore();
      error.mockRestore();
    }
  });

  it('falls back to the wall clock and to no Directory when neither is injected', async () => {
    const { url, repo, settings } = await startServer({ injectClock: false });
    await settings.update({
      setupComplete: true,
      exportToken: 'csv-secret',
      scimToken: 'scim-secret',
      oauthClientId: 'x.apps.googleusercontent.com',
      oauthClientSecret: 's',
      samlIdpEntityId: 'https://idp.example',
      samlIdpSsoUrl: 'https://idp.example/sso',
      samlIdpCert: 'MIICfake',
    });
    const standup = await seedStandup(repo);
    await repo.upsertParticipant({ standupId: standup.id, userName: 'users/42', displayName: 'Asha' });

    const csv = await fetch(`${url}/export?standupId=${standup.id}`, { headers: { authorization: 'Bearer csv-secret' } });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-disposition')).toContain(`standup-${standup.id}-last-30d.csv`);

    const home = await fetch(`${url}/dashboard`, { headers: { cookie: 'asyncup_dash=dash-secret' } });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Daily Standup');

    const session = `asyncup_sess=${sealSession(SECRET, newSession({ sub: '42', email: 'asha@org.com', name: 'Asha', admin: false }))}`;
    const me = await fetch(`${url}/me`, { headers: { cookie: session } });
    expect(me.status).toBe(200);
    expect(await me.text()).toContain('Daily Standup');

    const scim = await fetch(`${url}/scim/v2/Users`, {
      method: 'POST',
      headers: { authorization: 'Bearer scim-secret', 'content-type': 'application/scim+json' },
      body: JSON.stringify({ userName: 'new@org.com', emails: [{ value: 'new@org.com', primary: true }] }),
    });
    expect(scim.status).toBe(201);
    expect((await repo.findScimUserByUserName('new@org.com'))!.chatUserName).toBeNull();

    const start = await fetch(`${url}/auth/google`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await fetch(`${url}/auth/callback?code=c&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: start.headers.get('set-cookie')!.split(';')[0]! },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/me');

    const acs = await fetch(`${url}/auth/saml/acs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'SAMLResponse=fake',
      redirect: 'manual',
    });
    expect(acs.status).toBe(302);
    expect(acs.headers.get('location')).toBe('/me');
  });
});
