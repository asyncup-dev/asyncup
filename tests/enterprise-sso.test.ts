import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { samlAdmin, type SamlBroker, type SamlProfile } from '../src/auth/saml.js';
import type { DirectoryUser } from '../src/core/directory.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const SECRET = 'sso-secret-key';
let close: (() => void) | null = null;

function fakeSamlBroker(profile: SamlProfile | null): SamlBroker {
  return {
    loginUrl: async (relay) => `https://idp.example/sso?relay=${relay}`,
    consume: async () => profile,
    spMetadata: () => '<EntityDescriptor>sp</EntityDescriptor>',
  };
}

async function startServer(opts: { saml?: SamlProfile | null; directoryUser?: DirectoryUser | null; scim?: boolean } = {}) {
  const stack = await makeStack();
  await stack.settings.update({
    samlIdpEntityId: 'https://idp.example',
    samlIdpSsoUrl: 'https://idp.example/sso',
    samlIdpCert: 'MIIC-fake-cert',
    ...(opts.scim ? { scimToken: 'scim-secret' } : {}),
  });
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router,
    scheduler: stack.scheduler,
    repo: stack.repo,
    adapter: stack.adapter,
    blockers: stack.blockers,
    settings: stack.settings,
    dashboardToken: 'dash-secret',
    skipVerification: true,
    secretKey: SECRET,
    directory:
      opts.directoryUser === undefined
        ? async () => null
        : async () => ({ lookup: async () => opts.directoryUser ?? null }),
    samlBroker: () => fakeSamlBroker(opts.saml ?? null),
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...stack, url };
}

afterEach(() => {
  close?.();
  close = null;
});

const acs = (url: string) =>
  fetch(`${url}/auth/saml/acs`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'SAMLResponse=fake',
    redirect: 'manual',
  });

describe('SAML sign-in', () => {
  it('maps the configured admin group to the admin role', async () => {
    const { url } = await startServer({
      saml: { nameId: 'asha@org.com', email: 'asha@org.com', displayName: 'Asha', attributes: { groups: ['eng', 'asyncup-admins'] } },
    });
    const res = await acs(url);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app');
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    expect(((await (await fetch(`${url}/api/v1/me`, { headers: { cookie } })).json()) as any).kind).toBe('admin');
  });

  it('sends regular members to the app and links them by cached email', async () => {
    const { url, repo } = await startServer({
      saml: { nameId: 'asha@org.com', email: 'asha@org.com', displayName: 'Asha', attributes: {} },
    });
    const standup = await seedStandup(repo);
    await repo.upsertParticipant({ standupId: standup.id, userName: 'users/77', displayName: 'Asha' });
    await repo.setUserEmail('users/77', 'asha@org.com');

    const res = await acs(url);
    expect(res.headers.get('location')).toBe('/app');
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const mine = (await (await fetch(`${url}/api/v1/me/standups`, { headers: { cookie } })).json()) as any;
    expect(mine.standups.map((x: any) => x.name)).toEqual(['Daily Standup']);
  });

  it('takes the Chat id and admin role from the Directory when configured', async () => {
    const { url } = await startServer({
      saml: { nameId: 'boss@org.com', email: 'boss@org.com', displayName: 'Boss', attributes: {} },
      directoryUser: { id: '99', email: 'boss@org.com', isAdmin: true, suspended: false },
    });
    const res = await acs(url);
    expect(res.headers.get('location')).toBe('/app');
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    expect(((await (await fetch(`${url}/api/v1/me`, { headers: { cookie } })).json()) as any).kind).toBe('admin');
  });

  it('serves SP metadata and rejects assertions without an email', async () => {
    const bad = await startServer({ saml: { nameId: 'x', email: '', displayName: '', attributes: {} } });
    expect((await acs(bad.url)).status).toBe(403);
    const meta = await fetch(`${bad.url}/auth/saml/metadata`);
    expect(meta.status).toBe(200);
    expect(await meta.text()).toContain('EntityDescriptor');
  });

  it('samlAdmin matches strings and arrays case-insensitively', () => {
    expect(samlAdmin({ groups: 'AsyncUp-Admins' }, 'groups', 'asyncup-admins')).toBe(true);
    expect(samlAdmin({ groups: ['eng'] }, 'groups', 'asyncup-admins')).toBe(false);
    expect(samlAdmin({}, 'groups', 'asyncup-admins')).toBe(false);
  });
});

describe('SCIM provisioning', () => {
  const headers = { authorization: 'Bearer scim-secret', 'content-type': 'application/scim+json' };

  it('requires the token and supports the create → filter → get cycle', async () => {
    const { url } = await startServer({ scim: true });
    expect((await fetch(`${url}/scim/v2/Users`)).status).toBe(401);
    expect((await fetch(`${url}/scim/v2/Users`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);

    const created = await fetch(`${url}/scim/v2/Users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userName: 'asha@org.com', displayName: 'Asha', emails: [{ value: 'asha@org.com', primary: true }] }),
    });
    expect(created.status).toBe(201);
    const user: any = await created.json();
    expect(user.id).toBeTruthy();
    expect(user.active).toBe(true);

    const dup = await fetch(`${url}/scim/v2/Users`, { method: 'POST', headers, body: JSON.stringify({ userName: 'asha@org.com' }) });
    expect(dup.status).toBe(409);

    const found: any = await (
      await fetch(`${url}/scim/v2/Users?filter=${encodeURIComponent('userName eq "asha@org.com"')}`, { headers })
    ).json();
    expect(found.totalResults).toBe(1);
    expect(found.Resources[0].id).toBe(user.id);

    const list: any = await (await fetch(`${url}/scim/v2/Users`, { headers })).json();
    expect(list.totalResults).toBe(1);
  });

  it('deactivation removes the person from every roster (via Directory mapping)', async () => {
    const { url, repo } = await startServer({
      scim: true,
      directoryUser: { id: '55', email: 'bob@org.com', isAdmin: false, suspended: false },
    });
    const standup = await seedStandup(repo);
    await repo.upsertParticipant({ standupId: standup.id, userName: 'users/55', displayName: 'Bob' });

    const created: any = await (
      await fetch(`${url}/scim/v2/Users`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ userName: 'bob@org.com', emails: [{ value: 'bob@org.com', primary: true }] }),
      })
    ).json();
    expect(created.id).toBeTruthy();
    expect((await repo.listParticipants(standup.id)).some((p) => p.userName === 'users/55')).toBe(true);

    const patched = await fetch(`${url}/scim/v2/Users/${created.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', value: { active: false } }],
      }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as any).active).toBe(false);
    expect((await repo.listParticipants(standup.id)).some((p) => p.userName === 'users/55')).toBe(false);
  });

  it('supports PUT replace and DELETE deactivate', async () => {
    const { url } = await startServer({ scim: true });
    const created: any = await (
      await fetch(`${url}/scim/v2/Users`, { method: 'POST', headers, body: JSON.stringify({ userName: 'carol@org.com' }) })
    ).json();

    const put: any = await (
      await fetch(`${url}/scim/v2/Users/${created.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ userName: 'carol@org.com', displayName: 'Carol R', active: true }),
      })
    ).json();
    expect(put.displayName).toBe('Carol R');

    expect((await fetch(`${url}/scim/v2/Users/${created.id}`, { method: 'DELETE', headers })).status).toBe(204);
    const after: any = await (await fetch(`${url}/scim/v2/Users/${created.id}`, { headers })).json();
    expect(after.active).toBe(false);
  });

  it('is disabled entirely without a token', async () => {
    const { url } = await startServer();
    expect((await fetch(`${url}/scim/v2/Users`, { headers })).status).toBe(404);
  });
});
