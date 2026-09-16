import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { deriveWebhookSecret } from '../src/core/crypto.js';
import { ANSWERS, makeStack, seedStandup } from './helpers.js';

function captureFetch(calls: { url: string; body: any; raw: string; headers: Record<string, string> }[], status = 200): typeof fetch {
  return (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), raw: init.body, headers: init.headers });
    return new Response('', { status });
  }) as typeof fetch;
}

describe('Webhooks', () => {
  it('POSTs submission and wrap_up events to the configured URL', async () => {
    const calls: Parameters<typeof captureFetch>[0] = [];
    const stack = await makeStack({ webhookFetch: captureFetch(calls) });
    const standup = await seedStandup(stack.repo);
    await stack.repo.updateStandup(standup.id, { webhookUrl: 'https://hooks.example/asyncup' });

    stack.clock.set('2026-06-10T09:30');
    await stack.scheduler.tick();
    const run = (await stack.repo.getRun(standup.id, '2026-06-10'))!;
    await stack.service.submit(run.id, 'users/alice', 'Alice', ANSWERS);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://hooks.example/asyncup');
    expect(calls[0]!.body).toMatchObject({
      event: 'submission',
      user: 'Alice',
      date: '2026-06-10',
      late: false,
      edited: false,
    });

    // editing sends another event, flagged edited
    await stack.service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    expect(calls[1]!.body).toMatchObject({ event: 'submission', edited: true });

    stack.clock.set('2026-06-10T11:30');
    await stack.scheduler.tick();
    const wrap = calls.find((c) => c.body.event === 'wrap_up')!;
    expect(wrap.body.summary).toMatchObject({ mandatorySubmitted: 1 });
  });

  it('signs every delivery with the derived per-standup secret', async () => {
    const calls: { url: string; body: any; raw: string; headers: Record<string, string> }[] = [];
    const stack = await makeStack({ webhookFetch: captureFetch(calls) });
    const standup = await seedStandup(stack.repo);
    await stack.repo.updateStandup(standup.id, { webhookUrl: 'https://hooks.example/asyncup' });

    stack.clock.set('2026-06-10T09:30');
    await stack.scheduler.tick();
    const run = (await stack.repo.getRun(standup.id, '2026-06-10'))!;
    await stack.service.submit(run.id, 'users/alice', 'Alice', ANSWERS);

    const secret = deriveWebhookSecret('test-secret-key', standup.id);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const expected = `sha256=${createHmac('sha256', secret).update(calls[0]!.raw).digest('hex')}`;
    expect(calls[0]!.headers['x-asyncup-signature']).toBe(expected);
  });

  it('stays silent without a webhook URL and survives webhook failures', async () => {
    const calls: Parameters<typeof captureFetch>[0] = [];
    const stack = await makeStack({ webhookFetch: captureFetch(calls, 500) });
    const standup = await seedStandup(stack.repo);

    stack.clock.set('2026-06-10T09:30');
    await stack.scheduler.tick();
    const run = (await stack.repo.getRun(standup.id, '2026-06-10'))!;
    await stack.service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    expect(calls).toHaveLength(0); // no URL configured

    // now configure a URL that answers 500 — submissions must still succeed
    await stack.repo.updateStandup(standup.id, { webhookUrl: 'https://hooks.example/dead' });
    const result = await stack.service.submit(run.id, 'users/bob', 'Bob', ANSWERS);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
