import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { createServer } from '../src/server.js';
import { ANSWERS, makeStack, seedStandup, TENANT } from './helpers.js';

let close: (() => void) | null = null;

async function startServer(opts: { tickToken?: string; exportToken?: string; dashboardToken?: string } = {}) {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router,
    verifier: null,
    scheduler: stack.scheduler,
    repo: stack.repo,
    tickToken: opts.tickToken ?? '',
    exportToken: opts.exportToken ?? '',
    dashboardToken: opts.dashboardToken ?? '',
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

describe('server', () => {
  it('responds to health checks', async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('drives the scheduler via POST /tick', async () => {
    const { url, repo, adapter, clock } = await startServer();
    await seedStandup(repo);
    clock.set('2026-06-10T09:30');

    const res = await fetch(`${url}/tick`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(adapter.dms.filter((d) => d.kind === 'prompt')).toHaveLength(3);
  });

  it('protects /tick when TICK_TOKEN is configured', async () => {
    const { url } = await startServer({ tickToken: 's3cret' });
    expect((await fetch(`${url}/tick`, { method: 'POST' })).status).toBe(401);
    expect(
      (
        await fetch(`${url}/tick`, {
          method: 'POST',
          headers: { authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/tick`, {
          method: 'POST',
          headers: { authorization: 'Bearer s3cret' },
        })
      ).status,
    ).toBe(200);
  });

  it('routes chat events', async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/chat/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'MESSAGE',
        space: { name: 'spaces/team', type: 'ROOM' },
        message: { argumentText: ' setup Crew' },
        user: { name: 'users/admin', displayName: 'Admin' },
      }),
    });
    const body: any = await res.json();
    expect(body.text).toContain('Crew');
  });

  it('disables /export without EXPORT_TOKEN and guards it with one', async () => {
    const disabled = await startServer();
    expect((await fetch(`${disabled.url}/export?standupId=1`)).status).toBe(404);
    close?.();

    const { url, repo, service, clock } = await startServer({ exportToken: 'csv-secret' });
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, '2026-06-09', 'k');
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    clock.set('2026-06-10T12:00');

    expect((await fetch(`${url}/export?standupId=${standup.id}`)).status).toBe(401);

    const res = await fetch(`${url}/export?standupId=${standup.id}&days=7`, {
      headers: { authorization: 'Bearer csv-secret' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const csv = await res.text();
    expect(csv).toContain('date,standup,person,late,edited,mood,question,answer');
    expect(csv).toContain('2026-06-09,Daily Standup,Alice,no,no,good');
    expect(csv).toContain('Shipped the auth refactor');

    expect(
      (await fetch(`${url}/export?standupId=999`, { headers: { authorization: 'Bearer csv-secret' } }))
        .status,
    ).toBe(404);
  });
});
