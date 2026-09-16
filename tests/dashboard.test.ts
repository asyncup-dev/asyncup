import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { createServer } from '../src/server.js';
import { ANSWERS, makeStack, seedStandup, TENANT } from './helpers.js';

let close: (() => void) | null = null;

async function startServer(dashboardToken = 'dash-secret') {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router,
    scheduler: stack.scheduler,
    repo: stack.repo,
    settings: stack.settings,
    dashboardToken,
    skipVerification: true,
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
    const { url } = await startServer('');
    expect((await fetch(`${url}/dashboard`)).status).toBe(404);
  });

  it('rejects missing/wrong credentials and accepts the token via query or cookie', async () => {
    const { url, get } = await startServer();
    const denied = await get('/dashboard', false);
    expect(denied.status).toBe(401);
    // operators get a token form, not just a hint
    expect(await denied.text()).toContain('name="token"');
    expect(
      (await fetch(`${url}/dashboard`, { headers: { cookie: 'asyncup_dash=wrong' } })).status,
    ).toBe(401);

    // A valid ?token= sets the cookie and immediately bounces to a clean URL
    // so the token never lingers in history, logs, or Referer headers.
    const viaQuery = await fetch(`${url}/dashboard?token=dash-secret`, { redirect: 'manual' });
    expect(viaQuery.status).toBe(303);
    expect(viaQuery.headers.get('location')).toBe('/dashboard');
    expect(viaQuery.headers.get('set-cookie')).toContain('asyncup_dash=');

    expect((await get('/dashboard')).status).toBe(200);
  });

  it('lists standups and shows the detail page with history and blockers', async () => {
    const { repo, service, get, clock, settings } = await startServer();
    await settings.update({ setupComplete: true }); // skip the first-run walkthrough redirect
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, '2026-06-10', 'k');
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

  it('serves the settings page, saves sections, and never echoes secrets', async () => {
    const { url, settings, get } = await startServer();

    const page = await (await get('/dashboard/settings')).text();
    expect(page).toContain('Google Chat');
    expect(page).toContain('AI summaries');
    expect(page).toContain('Access tokens');

    const post = (body: Record<string, string>) =>
      fetch(`${url}/dashboard/settings`, {
        method: 'POST',
        headers: {
          cookie: 'asyncup_dash=dash-secret',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual',
      });

    expect((await post({ section: 'chat', chatAudience: 'not-a-number' })).status).toBe(400);

    const ok = await post({
      section: 'chat',
      chatAudience: '987654',
      serviceAccountJson: JSON.stringify({ client_email: 'bot@p.iam.gserviceaccount.com', private_key: 'k' }),
    });
    expect(ok.status).toBe(302);
    const saved = await settings.get();
    expect(saved.chatAudience).toBe('987654');
    expect(saved.serviceAccountJson).toContain('client_email');

    // the page shows status, never the key material
    const after = await (await get('/dashboard/settings')).text();
    expect(after).toContain('bot@p.iam.gserviceaccount.com');
    expect(after).not.toContain('private_key');

    // saving AI section with empty key keeps configured values intact
    expect((await post({ section: 'ai', aiOn: 'on', llmProvider: 'anthropic', llmModel: '' })).status).toBe(302);
    expect((await settings.get()).llmProvider).toBe('anthropic');

    // unchecking the master toggle turns the feature off even though the
    // (CSS-hidden) provider fields still submit
    expect((await post({ section: 'ai', llmProvider: 'anthropic' })).status).toBe(302);
    expect((await settings.get()).llmProvider).toBe('');
  });

  it('generates tokens shown once and enforces them on /tick', async () => {
    const { url, settings } = await startServer();
    const res = await fetch(`${url}/dashboard/settings`, {
      method: 'POST',
      headers: {
        cookie: 'asyncup_dash=dash-secret',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ action: 'generate-tick' }).toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const token = (await settings.get()).tickToken;
    expect(token).not.toBe('');
    expect(html).toContain(token); // revealed exactly once on this response

    const fresh = await (await fetch(`${url}/dashboard/settings`, { headers: { cookie: 'asyncup_dash=dash-secret' } })).text();
    expect(fresh).not.toContain(token);

    expect((await fetch(`${url}/tick`, { method: 'POST' })).status).toBe(401);
    expect(
      (await fetch(`${url}/tick`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(200);
  });

  it('runs today\'s standup from the ▶ Run now button', async () => {
    const { repo, url, adapter, clock } = await startServer();
    const standup = await seedStandup(repo);
    clock.set('2026-06-10T07:00'); // before prompt time

    const res = await fetch(`${url}/dashboard/standup/${standup.id}/run-now`, {
      method: 'POST',
      headers: { cookie: 'asyncup_dash=dash-secret' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('notice=');
    expect(await repo.getRun(standup.id, '2026-06-10')).not.toBeNull();
    expect(adapter.dms.filter((d) => d.kind === 'prompt')).toHaveLength(3);
  });

  it('manages the roster and downloads CSV from the standup page', async () => {
    const { repo, url, get, service, clock } = await startServer();
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, '2026-06-09', 'k');
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    clock.set('2026-06-10T12:00');

    const post = (body: Record<string, string>) =>
      fetch(`${url}/dashboard/standup/${standup.id}/roster`, {
        method: 'POST',
        headers: {
          cookie: 'asyncup_dash=dash-secret',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual',
      });

    expect((await post({ action: 'optional', userName: 'users/alice' })).status).toBe(302);
    expect(
      (await repo.listParticipants(standup.id)).find((p) => p.userName === 'users/alice')?.mandatory,
    ).toBe(false);

    expect((await post({ action: 'admin', userName: 'users/alice' })).status).toBe(302);
    expect(await repo.isAdmin(standup.id, 'users/alice')).toBe(true);

    expect((await post({ action: 'remove', userName: 'users/bob' })).status).toBe(302);
    expect((await repo.listParticipants(standup.id)).map((p) => p.userName)).not.toContain('users/bob');

    const csv = await get(`/dashboard/standup/${standup.id}/export.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('Alice');

    // roster writes require auth
    const unauthed = await fetch(`${url}/dashboard/standup/${standup.id}/roster`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'remove', userName: 'users/alice' }).toString(),
    });
    expect(unauthed.status).toBe(401);
  });

  it('walks a fresh install through setup and lands on home when finished', async () => {
    const { url, settings, get } = await startServer();

    // Fresh install: home hands over to the walkthrough.
    const home = await fetch(`${url}/dashboard`, {
      headers: { cookie: 'asyncup_dash=dash-secret' },
      redirect: 'manual',
    });
    expect(home.status).toBe(303);
    expect(home.headers.get('location')).toBe('/dashboard/setup');

    const wizard = await (await get('/dashboard/setup')).text();
    expect(wizard).toContain('Welcome to AsyncUp');
    expect(wizard).toContain('How will people sign in?');

    const post = (body: Record<string, string>) =>
      fetch(`${url}/dashboard/setup`, {
        method: 'POST',
        headers: {
          cookie: 'asyncup_dash=dash-secret',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual',
      });

    // Step 2 saves the Chat connection and advances.
    const step2 = await post({
      section: 'chat',
      step: '2',
      chatAudience: '987654',
      serviceAccountJson: JSON.stringify({ client_email: 'bot@p.iam.gserviceaccount.com', private_key: 'k' }),
    });
    expect(step2.status).toBe(303);
    expect(step2.headers.get('location')).toBe('/dashboard/setup?step=3');

    // A bad value re-renders the step with the error.
    const bad = await post({ section: 'workspace', step: '3', defaultTimezone: 'Not/AZone' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Invalid IANA timezone');

    // Finish marks setup complete; home serves the standup list from now on.
    const done = await post({ action: 'finish' });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/dashboard');
    expect((await settings.get()).setupComplete).toBe(true);
    expect(await (await get('/dashboard')).text()).toContain('Standups');
  });

  it('saves one value per box and enforces the token sign-in lockout guard', async () => {
    const { url, settings } = await startServer();
    const post = (body: Record<string, string>) =>
      fetch(`${url}/dashboard/settings`, {
        method: 'POST',
        headers: {
          cookie: 'asyncup_dash=dash-secret',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual',
      });

    // Per-field save with validation.
    expect((await post({ section: 'field', key: 'chatAudience', value: 'not-a-number' })).status).toBe(400);
    expect((await post({ section: 'field', key: 'chatAudience', value: '987654' })).status).toBe(302);
    expect((await settings.get()).chatAudience).toBe('987654');
    expect((await post({ section: 'field', key: 'nope', value: 'x' })).status).toBe(400);

    // Empty save keeps a stored secret; the clear checkbox wipes it.
    await settings.update({ llmApiKey: 'sk-keepme' });
    expect((await post({ section: 'field', key: 'llmApiKey', value: '' })).status).toBe(302);
    expect((await settings.get()).llmApiKey).toBe('sk-keepme');
    expect((await post({ section: 'field', key: 'llmApiKey', value: '', clear: 'on' })).status).toBe(302);
    expect((await settings.get()).llmApiKey).toBe('');

    // Token sign-in cannot be switched off while it is the only way in.
    const refused = await post({ section: 'field', key: 'tokenSignIn' });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Configure Google or SAML');
    expect((await settings.get()).tokenSignIn).toBe(true);

    // With Google sign-in configured the switch works — and the token dies.
    await settings.update({ oauthClientId: 'x.apps.googleusercontent.com', oauthClientSecret: 'GOCSPX-x' });
    expect((await post({ section: 'field', key: 'tokenSignIn' })).status).toBe(302);
    expect((await settings.get()).tokenSignIn).toBe(false);
    const denied = await fetch(`${url}/dashboard`, { headers: { cookie: 'asyncup_dash=dash-secret' } });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain('name="token"'); // form gone from the sign-in page

    // Clearing the OAuth client now would remove the last way in — refused.
    const lockout = await fetch(`${url}/dashboard/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ section: 'field', key: 'oauthClientId', value: '' }).toString(),
    });
    expect(lockout.status).toBe(401); // token access is off, so even the request is unauthenticated
    // Re-enable via the documented DB path: delete the row (fresh service sees the default again).
    await settings.update({ tokenSignIn: true });
    const restored = await fetch(`${url}/dashboard`, { headers: { cookie: 'asyncup_dash=dash-secret' } });
    expect(restored.status).toBe(200);
  });

  it('updates configuration via the form and validates input', async () => {
    const { repo, url } = await startServer();
    const standup = await seedStandup(repo);
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

    const updated = (await repo.getStandupById(standup.id))!;
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
    expect((await repo.getStandupById(standup.id))!.promptTime).toBe('08:15');

    // config write requires auth
    const unauthed = await fetch(`${url}/dashboard/standup/${standup.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(valid).toString(),
    });
    expect(unauthed.status).toBe(401);
  });
});
