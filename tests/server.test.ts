import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

let close: (() => void) | null = null;

function startServer(tickToken = '') {
  const stack = makeStack();
  const router = new EventRouter(stack.commands, stack.service, TENANT);
  const app = createServer(router, null, stack.scheduler, tickToken);
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
    const { url } = startServer();
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('drives the scheduler via POST /tick', async () => {
    const { url, repo, adapter, clock } = startServer();
    seedStandup(repo);
    clock.set('2026-06-10T09:30');

    const res = await fetch(`${url}/tick`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(adapter.dms.filter((d) => d.kind === 'prompt')).toHaveLength(3);
  });

  it('protects /tick when TICK_TOKEN is configured', async () => {
    const { url } = startServer('s3cret');
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
    const { url } = startServer();
    const res = await fetch(`${url}/chat/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'MESSAGE',
        space: { name: 'spaces/team', type: 'ROOM' },
        message: { argumentText: ' setup Crew' },
      }),
    });
    const body: any = await res.json();
    expect(body.text).toContain('Crew');
  });
});
