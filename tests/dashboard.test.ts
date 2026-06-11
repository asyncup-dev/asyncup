import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { createServer } from '../src/server.js';
import { ANSWERS, makeStack, seedStandup, TENANT } from './helpers.js';

let close: (() => void) | null = null;

function startServer(dashboardToken = 'dash-secret') {
  const stack = makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.repo, TENANT);
  const app = createServer({
    router,
    verifier: null,
    scheduler: stack.scheduler,
    repo: stack.repo,
    tickToken: '',
    exportToken: '',
    dashboardToken,
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, withAuth = true) =>
    fetch(`${url}${path}`, withAuth ? { headers: { cookie: `asyncup_dash=${dashboardToken}` } } : {});
  return { ...stack, url, get };
}

afterEach(() => {
  close?.();
  close = null;
});

describe('dashboard', () => {
  it('is disabled entirely without a token', async () => {
    const { url } = startServer('');
    expect((await fetch(`${url}/dashboard`)).status).toBe(404);
  });

  it('rejects missing/wrong credentials and accepts the token via query or cookie', async () => {
    const { url, get } = startServer();
    expect((await get('/dashboard', false)).status).toBe(401);
    expect(
      (await fetch(`${url}/dashboard`, { headers: { cookie: 'asyncup_dash=wrong' } })).status,
    ).toBe(401);

    const viaQuery = await fetch(`${url}/dashboard?token=dash-secret`);
    expect(viaQuery.status).toBe(200);
    expect(viaQuery.headers.get('set-cookie')).toContain('asyncup_dash=');

    expect((await get('/dashboard')).status).toBe(200);
  });

  it('lists standups and shows the detail page with history and blockers', async () => {
    const { repo, service, get, clock } = startServer();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'k');
    await service.submit(run.id, 'users/alice', 'Alice', {
      ...ANSWERS,
      answers: [...ANSWERS.answers.slice(0, 2), { question: 'Any blockers?', answer: 'Stuck on VPN' }],
    });
    clock.set('2026-06-10T12:00');

    const list = await (await get('/dashboard')).text();
    expect(list).toContain('Daily Standup');
    expect(list).toContain(`/dashboard/standup/${standup.id}`);

    const detail = await (await get(`/dashboard/standup/${standup.id}`)).text();
    expect(detail).toContain('Daily Standup');
    expect(detail).toContain('Alice');
    expect(detail).toContain('Stuck on VPN');
    expect(detail).toContain('2026-06-10');

    const runPage = await (await get(`/dashboard/standup/${standup.id}/run/2026-06-10`)).text();
    expect(runPage).toContain('Stuck on VPN');
    expect(runPage).toContain('What will you do today?');
  });

  it('updates configuration via the form and validates input', async () => {
    const { repo, url, get } = startServer();
    const standup = seedStandup(repo);
    const post = (body: Record<string, string>) =>
      fetch(`${url}/dashboard/standup/${standup.id}`, {
        method: 'POST',
        headers: {
          cookie: 'asyncup_dash=dash-secret',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual',
      });

    const valid = {
      name: 'Renamed Standup',
      promptTime: '08:15',
      deadlineTime: '10:45',
      timezone: 'Europe/Berlin',
      days: 'mon,wed,fri',
      reminderMinutesBefore: '30',
      escalateAfterDays: '4',
      questions: 'What shipped?\nAny blockers?',
      moodEnabled: 'on',
      moodAnonymous: 'on',
    };
    const ok = await post(valid);
    expect(ok.status).toBe(302);

    const updated = repo.getStandupById(standup.id)!;
    expect(updated.name).toBe('Renamed Standup');
    expect(updated.promptTime).toBe('08:15');
    expect(updated.timezone).toBe('Europe/Berlin');
    expect(updated.days).toBe('mon,wed,fri');
    expect(updated.questions).toEqual(['What shipped?', 'Any blockers?']);
    expect(updated.moodAnonymous).toBe(true);
    expect(updated.digestEnabled).toBe(false); // unchecked checkbox = off
    expect(updated.escalateAfterDays).toBe(4);

    const bad = await post({ ...valid, promptTime: '25:99' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('HH:MM');
    expect(repo.getStandupById(standup.id)!.promptTime).toBe('08:15');

    // config write requires auth
    const unauthed = await fetch(`${url}/dashboard/standup/${standup.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(valid).toString(),
    });
    expect(unauthed.status).toBe(401);
  });
});
