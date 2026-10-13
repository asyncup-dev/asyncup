import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

async function startServer(webhookSecret?: (standupId: number) => string) {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({ router, scheduler: stack.scheduler, adapter: stack.adapter, blockers: stack.blockers, repo: stack.repo, settings: stack.settings, dashboardToken: 'op', skipVerification: true, secretKey: 'k', webhookSecret, now: stack.clock.now });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const as = (auth: Record<string, string>) => (id: number) => fetch(`${url}/standups/${id}/webhook/secret`, { headers: auth });
  const cookie = (sub: string) => ({ cookie: `asyncup_sess=${sealSession('k', newSession({ sub, email: `${sub}@o.com`, name: sub, admin: false }))}` });
  return { ...stack, op: as({ authorization: 'Bearer op' }), person: (sub: string) => as(cookie(sub)) };
}

describe('webhook signing secret', () => {
  it('shows the key to admins and this standup’s managers only', async () => {
    const { repo, op, person } = await startServer((id) => `secret-${id}`);
    const standup = await seedStandup(repo);
    const other = await seedStandup(repo, { spaceName: 'spaces/other' });
    await repo.addAdmin(standup.id, 'users/bob', 'Bob');
    await repo.addAdmin(other.id, 'users/cat', 'Cat');

    expect(await (await op(standup.id)).json()).toEqual({ secret: `secret-${standup.id}` });
    expect(await (await person('bob')(standup.id)).json()).toEqual({ secret: `secret-${standup.id}` });
    // a participant sees the standup but doesn't manage it; another standup's manager can't see it at all
    expect((await person('alice')(standup.id)).status).toBe(403);
    expect((await person('cat')(standup.id)).status).toBe(404);
    expect((await op(9999)).status).toBe(404);
  });

  it('says so when the host has no signing key', async () => {
    const { repo, op } = await startServer();
    const standup = await seedStandup(repo);
    const res = await op(standup.id);
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.code).toBe('unavailable');
  });
});
