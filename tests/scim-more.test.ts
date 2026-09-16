import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import type { UserDirectory } from '../src/core/directory.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const headers = { authorization: 'Bearer scim-secret', 'content-type': 'application/scim+json' };
let close: (() => void) | null = null;

async function startServer(opts: { directory?: () => Promise<UserDirectory | null> } = {}) {
  const stack = await makeStack();
  await stack.settings.update({ scimToken: 'scim-secret' });
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router,
    scheduler: stack.scheduler,
    repo: stack.repo,
    adapter: stack.adapter,
    blockers: stack.blockers,
    settings: stack.settings,
    dashboardToken: '',
    skipVerification: true,
    directory: opts.directory ?? (async () => null),
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const users = `${url}/scim/v2/Users`;
  const create = async (body: object): Promise<any> =>
    (await fetch(users, { method: 'POST', headers, body: JSON.stringify(body) })).json();
  const patch = (id: string, body: object) =>
    fetch(`${users}/${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  return { ...stack, url, users, create, patch };
}

afterEach(() => {
  close?.();
  close = null;
});

describe('SCIM service provider config', () => {
  it('is served behind the bearer token', async () => {
    const { url } = await startServer();
    expect((await fetch(`${url}/scim/v2/ServiceProviderConfig`)).status).toBe(401);
    const res = await fetch(`${url}/scim/v2/ServiceProviderConfig`, { headers });
    expect(res.status).toBe(200);
    const config: any = await res.json();
    expect(config.patch.supported).toBe(true);
    expect(config.bulk.supported).toBe(false);
    expect(config.filter.maxResults).toBe(200);
    expect(config.authenticationSchemes[0].type).toBe('oauthbearertoken');
  });
});

describe('SCIM users', () => {
  it('rejects every filter other than userName eq', async () => {
    const { users } = await startServer();
    const res = await fetch(`${users}?filter=${encodeURIComponent('displayName co "A"')}`, { headers });
    expect(res.status).toBe(501);
    const body: any = await res.json();
    expect(body.detail).toContain('userName eq');
  });

  it('paginates the list with startIndex and count', async () => {
    const { users, create } = await startServer();
    for (const name of ['a@org.com', 'b@org.com', 'c@org.com']) await create({ userName: name });
    const page: any = await (await fetch(`${users}?startIndex=2&count=1`, { headers })).json();
    expect(page.totalResults).toBe(3);
    expect(page.startIndex).toBe(2);
    expect(page.itemsPerPage).toBe(1);
    expect(page.Resources).toHaveLength(1);
    expect(['a@org.com', 'b@org.com', 'c@org.com']).toContain(page.Resources[0].userName);
  });

  it('requires a userName on create and replace, and 404s unknown ids', async () => {
    const { users, create } = await startServer();
    const missing = await fetch(users, { method: 'POST', headers, body: JSON.stringify({ displayName: 'Nobody' }) });
    expect(missing.status).toBe(400);
    const created = await create({ userName: 'asha@org.com' });
    const blank = await fetch(`${users}/${created.id}`, { method: 'PUT', headers, body: JSON.stringify({ userName: '' }) });
    expect(blank.status).toBe(400);

    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${users}/nope`, { method, headers, body: method === 'GET' ? undefined : '{}' });
      expect(res.status).toBe(404);
    }
  });

  it('rejects patches that are not a PatchOp with Operations', async () => {
    const { create, patch } = await startServer();
    const created = await create({ userName: 'asha@org.com' });
    const noSchema = await patch(created.id, { Operations: [] });
    expect(noSchema.status).toBe(400);
    expect(((await noSchema.json()) as any).detail).toContain('PatchOp');
    expect((await patch(created.id, { schemas: [PATCH_SCHEMA] })).status).toBe(400);
  });

  it('applies path-addressed operations and skips the ones it does not support', async () => {
    const { create, patch } = await startServer();
    const created = await create({ userName: 'asha@org.com', displayName: 'Asha', externalId: 'ext-0' });

    const first = await patch(created.id, {
      schemas: [PATCH_SCHEMA],
      Operations: [
        { op: 'Replace', path: 'displayName', value: 'Asha R' },
        { op: 'add', path: 'externalId', value: 'ext-1' },
        { op: 'remove', path: 'displayName' },
        { op: 'replace', path: 'userName', value: 'asha.r@org.com' },
      ],
    });
    expect(first.status).toBe(200);
    const renamed: any = await first.json();
    expect(renamed.displayName).toBe('Asha R');
    expect(renamed.externalId).toBe('ext-1');
    expect(renamed.userName).toBe('asha.r@org.com');
    expect(renamed.active).toBe(true);

    const second = await patch(created.id, {
      schemas: [PATCH_SCHEMA],
      Operations: [
        { op: 'replace', path: 'name.formatted', value: '' },
        { op: 'replace', path: 'externalId', value: '' },
        { op: 'replace', path: 'active', value: 'False' },
      ],
    });
    const cleared: any = await second.json();
    expect(cleared.displayName).toBeUndefined();
    expect(cleared.externalId).toBeUndefined();
    expect(cleared.active).toBe(false);
  });

  it('links users through cached emails when there is no Directory', async () => {
    const { repo, create, users } = await startServer();
    const standup = await seedStandup(repo);
    await repo.upsertParticipant({ standupId: standup.id, userName: 'users/77', displayName: 'Bob' });
    await repo.setUserEmail('users/77', 'bob@org.com');

    const created = await create({ userName: 'bob@org.com' });
    expect((await repo.findScimUserByUserName('bob@org.com'))!.chatUserName).toBe('users/77');

    const put = await fetch(`${users}/${created.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ userName: 'bob@org.com', active: 'false' }),
    });
    expect(((await put.json()) as any).active).toBe(false);
    expect((await repo.listParticipants(standup.id)).some((p) => p.userName === 'users/77')).toBe(false);
  });

  it('survives a failing Directory lookup', async () => {
    const { repo, create, users } = await startServer({
      directory: async () => ({
        lookup: async () => {
          throw new Error('directory down');
        },
      }),
    });
    const errors: string[] = [];
    const error = spyOn(console, 'error').mockImplementation((m?: unknown) => void errors.push(String(m)));
    try {
      const created = await create({ userName: 'carol@org.com', active: false });
      expect(created.id).toBeTruthy();
      expect(created.active).toBe(false);
      expect((await repo.findScimUserByUserName('carol@org.com'))!.chatUserName).toBeNull();
      expect(errors.some((m) => m.includes('[scim] directory lookup failed:'))).toBe(true);
      expect((await fetch(`${users}/${created.id}`, { headers })).status).toBe(200);
    } finally {
      error.mockRestore();
    }
  });
});
