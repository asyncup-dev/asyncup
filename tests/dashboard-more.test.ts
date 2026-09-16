import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { LIMITS } from '../src/core/validation.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const TOKEN = 'dash-secret';
const SECRET = 'dashboard-more-secret';
const FORM = 'application/x-www-form-urlencoded';
let close: (() => void) | null = null;

async function startServer() {
  const stack = await makeStack();
  await stack.settings.update({ setupComplete: true });
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router,
    scheduler: stack.scheduler,
    repo: stack.repo,
    settings: stack.settings,
    dashboardToken: TOKEN,
    skipVerification: true,
    secretKey: SECRET,
    webhookSecret: (standupId) => `whsec-${standupId}`,
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dashCookie = `asyncup_dash=${TOKEN}`;
  const get = (path: string, cookie = dashCookie) => fetch(`${url}${path}`, { headers: { cookie } });
  const post = (path: string, body: Record<string, string>, cookie = dashCookie) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': FORM },
      body: new URLSearchParams(body).toString(),
      redirect: 'manual',
    });
  const sessionCookie = (identity: Parameters<typeof newSession>[0]) =>
    `asyncup_sess=${sealSession(SECRET, newSession(identity))}`;
  return { ...stack, url, get, post, sessionCookie };
}

afterEach(() => {
  close?.();
  close = null;
});

const VALID_CONFIG = {
  name: 'Daily Standup',
  promptTime: '09:30',
  deadlineTime: '11:30',
  timezone: 'Asia/Kolkata',
  days: 'mon,tue,wed,thu,fri',
  reminderMinutesBefore: '60',
  escalateAfterDays: '3',
  questions: 'What did you do?\nWhat will you do?',
};

describe('dashboard token handling', () => {
  it('accepts ?token= on a POST without the GET bounce and still sets the cookie', async () => {
    const { url, settings } = await startServer();
    await settings.update({ tickToken: 'tick-1' });
    const res = await fetch(`${url}/dashboard/settings?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': FORM },
      body: new URLSearchParams({ action: 'clear-tick' }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard/settings?saved=1');
    expect(res.headers.get('set-cookie')).toContain('asyncup_dash=');
    expect((await settings.get()).tickToken).toBe('');
  });

  it('generates and clears the export and SCIM tokens', async () => {
    const { post, settings } = await startServer();
    for (const which of ['export', 'scim'] as const) {
      const field = `${which}Token` as const;
      expect((await post('/dashboard/settings', { action: `generate-${which}` })).status).toBe(200);
      expect((await settings.get())[field]).not.toBe('');
      const cleared = await post('/dashboard/settings', { action: `clear-${which}` });
      expect(cleared.status).toBe(302);
      expect((await settings.get())[field]).toBe('');
    }
  });

  it('rejects unknown token actions', async () => {
    const { post } = await startServer();
    const badVerb = await post('/dashboard/settings', { action: 'frobnicate-tick' });
    expect(badVerb.status).toBe(400);
    expect(await badVerb.text()).toContain('Unknown action.');
    expect((await post('/dashboard/settings', { action: 'generate-nope' })).status).toBe(400);
  });
});

describe('dashboard roster actions', () => {
  it('marks people away and back', async () => {
    const { repo, post } = await startServer();
    const standup = await seedStandup(repo);
    const roster = `/dashboard/standup/${standup.id}/roster`;
    const alice = async () => (await repo.listParticipants(standup.id)).find((p) => p.userName === 'users/alice')!;

    const away = await post(roster, { action: 'vacation', userName: 'users/alice' });
    expect(away.status).toBe(302);
    expect(away.headers.get('location')).toContain(encodeURIComponent('Marked away.'));
    expect((await alice()).onVacation).toBe(true);

    const back = await post(roster, { action: 'back', userName: 'users/alice' });
    expect(back.headers.get('location')).toContain(encodeURIComponent('Marked back.'));
    expect((await alice()).onVacation).toBe(false);
  });

  it('keeps at least one admin on the standup', async () => {
    const { repo, post } = await startServer();
    const standup = await seedStandup(repo);
    const roster = `/dashboard/standup/${standup.id}/roster`;

    expect((await post(roster, { action: 'admin', userName: 'users/alice' })).status).toBe(302);
    const refused = await post(roster, { action: 'unadmin', userName: 'users/alice' });
    expect(refused.headers.get('location')).toContain(encodeURIComponent('A standup must keep at least one admin.'));
    expect(await repo.isAdmin(standup.id, 'users/alice')).toBe(true);

    await post(roster, { action: 'admin', userName: 'users/bob' });
    const removed = await post(roster, { action: 'unadmin', userName: 'users/alice' });
    expect(removed.headers.get('location')).toContain(encodeURIComponent('Admin removed.'));
    expect(await repo.isAdmin(standup.id, 'users/alice')).toBe(false);
    expect(await repo.isAdmin(standup.id, 'users/bob')).toBe(true);
  });

  it('reports non-participants and refuses unknown actions', async () => {
    const { repo, post } = await startServer();
    const standup = await seedStandup(repo);
    const roster = `/dashboard/standup/${standup.id}/roster`;

    const admin = await post(roster, { action: 'admin', userName: 'users/zed' });
    expect(admin.headers.get('location')).toContain(encodeURIComponent('Not a participant.'));
    const remove = await post(roster, { action: 'remove', userName: 'users/zed' });
    expect(remove.headers.get('location')).toContain(encodeURIComponent('Not a participant.'));

    const unknown = await post(roster, { action: 'explode', userName: 'users/alice' });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('Unknown roster action.');
  });
});

describe('dashboard not-found pages', () => {
  it('renders a consistent 404 for unknown standups and runs', async () => {
    const { repo, get, post } = await startServer();
    const standup = await seedStandup(repo);

    const missing = await get('/dashboard/standup/999');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('Unknown standup.');

    const run = await get(`/dashboard/standup/${standup.id}/run/2020-01-01`);
    expect(run.status).toBe(404);
    expect(await run.text()).toContain('Unknown run.');

    expect((await get('/dashboard/standup/999/export.csv')).status).toBe(404);
    expect((await post('/dashboard/standup/999', VALID_CONFIG)).status).toBe(404);
    expect((await post('/dashboard/standup/999/roster', { action: 'remove', userName: 'users/alice' })).status).toBe(404);
    expect((await post('/dashboard/standup/999/run-now', {})).status).toBe(404);
  });
});

describe('standup configuration form', () => {
  it('validates time ordering, question count and length, and the escalation contact', async () => {
    const { repo, post } = await startServer();
    const standup = await seedStandup(repo);
    const path = `/dashboard/standup/${standup.id}`;

    const ordering = await post(path, { ...VALID_CONFIG, promptTime: '11:00', deadlineTime: '10:00' });
    expect(ordering.status).toBe(400);
    expect(await ordering.text()).toContain('Prompt time must be before the deadline.');

    const escalate = await post(path, { ...VALID_CONFIG, escalateAfterDays: '0' });
    expect(escalate.status).toBe(400);
    expect(await escalate.text()).toContain(`Escalation days must be ${LIMITS.escalateDaysMin}–${LIMITS.escalateDaysMax}.`);

    const none = await post(path, { ...VALID_CONFIG, questions: '\n\n' });
    expect(none.status).toBe(400);
    expect(await none.text()).toContain(`Provide 1–${LIMITS.questionsMax} questions`);

    const long = await post(path, { ...VALID_CONFIG, questions: 'x'.repeat(LIMITS.textMax + 1) });
    expect(long.status).toBe(400);
    expect(await long.text()).toContain(`Questions must be ≤${LIMITS.textMax} characters.`);

    const stranger = await post(path, { ...VALID_CONFIG, escalateUserName: 'users/nobody' });
    expect(stranger.status).toBe(400);
    expect(await stranger.text()).toContain('Escalation contact must be a current participant.');
    expect((await repo.getStandupById(standup.id))!.escalateUserName).toBeNull();

    expect((await post(path, { ...VALID_CONFIG, escalateUserName: 'users/alice' })).status).toBe(302);
    const updated = (await repo.getStandupById(standup.id))!;
    expect(updated.escalateUserName).toBe('users/alice');
    expect(updated.escalateDisplayName).toBe('Alice');
  });

  it('shows the signing secret only once a webhook URL is configured', async () => {
    const { repo, get, post } = await startServer();
    const standup = await seedStandup(repo);
    const path = `/dashboard/standup/${standup.id}`;
    expect(await (await get(path)).text()).not.toContain('signing secret');

    const insecure = await post(path, { ...VALID_CONFIG, webhookUrl: 'http://hooks.example/asyncup' });
    expect(insecure.status).toBe(400);
    expect(await insecure.text()).toContain('Webhook URL must be https://');

    expect((await post(path, { ...VALID_CONFIG, webhookUrl: 'https://hooks.example/asyncup' })).status).toBe(302);
    const page = await (await get(path)).text();
    expect(page).toContain('X-AsyncUp-Signature');
    expect(page).toContain(`<code>whsec-${standup.id}</code>`);
  });

  it('lists admins with a remove control once there are any', async () => {
    const { repo, get } = await startServer();
    const standup = await seedStandup(repo);
    const path = `/dashboard/standup/${standup.id}`;

    expect(await (await get(path)).text()).toContain('none (open config)');
    await repo.addAdmin(standup.id, 'users/alice', 'Alice');
    const page = await (await get(path)).text();
    expect(page).toContain('Remove admin');
    expect(page).not.toContain('none (open config)');
  });
});

describe('setup walkthrough', () => {
  it('stays on the current step when asked and finishes from the extras form', async () => {
    const { post, settings } = await startServer();
    await settings.update({ setupComplete: false });

    const stay = await post('/dashboard/setup', { section: 'field', key: 'tokenSignIn', value: 'on', step: '1', stay: '1' });
    expect(stay.status).toBe(303);
    expect(stay.headers.get('location')).toBe('/dashboard/setup?step=1');

    const finish = await post('/dashboard/setup', {
      section: 'workspace',
      step: '3',
      finish: '1',
      defaultTimezone: 'Europe/Berlin',
      calendarOoo: 'on',
    });
    expect(finish.status).toBe(303);
    expect(finish.headers.get('location')).toBe('/dashboard');
    const saved = await settings.get();
    expect(saved.setupComplete).toBe(true);
    expect(saved.defaultTimezone).toBe('Europe/Berlin');
  });

  it('clamps the requested step to the last one', async () => {
    const { get } = await startServer();
    expect(await (await get('/dashboard/setup?step=9')).text()).toContain('Workspace defaults');
  });
});

describe('user console account linking', () => {
  it('tells an account with no Chat identity to use the bot first', async () => {
    const { post, get, sessionCookie } = await startServer();
    const cookie = sessionCookie({ sub: '', email: 'ghost@org.com', name: 'Ghost', admin: false });
    expect(await (await get('/me', cookie)).text()).toContain("isn't linked to Google Chat yet");

    const tz = await post('/me/timezone', { timezone: 'Europe/Berlin' }, cookie);
    expect(tz.status).toBe(302);
    expect(tz.headers.get('location')).toBe(`/me?notice=${encodeURIComponent('Account not linked to Chat yet.')}`);

    const vacation = await post('/me/vacation', { state: 'on' }, cookie);
    expect(vacation.status).toBe(302);
    expect(vacation.headers.get('location')).toBe(`/me?notice=${encodeURIComponent('Account not linked to Chat yet.')}`);
  });

  it('rejects an invalid timezone and clears it on an empty save', async () => {
    const { repo, post, sessionCookie } = await startServer();
    const standup = await seedStandup(repo);
    await repo.upsertParticipant({ standupId: standup.id, userName: 'users/42', displayName: 'Asha' });
    const cookie = sessionCookie({ sub: '42', email: 'asha@org.com', name: 'Asha', admin: false });

    const bad = await post('/me/timezone', { timezone: 'Not/AZone' }, cookie);
    expect(bad.status).toBe(302);
    expect(bad.headers.get('location')).toContain(encodeURIComponent('Invalid IANA timezone: Not/AZone'));
    expect(await repo.getUserTimezone('users/42')).toBeNull();

    await post('/me/timezone', { timezone: 'Europe/Berlin' }, cookie);
    expect(await repo.getUserTimezone('users/42')).toBe('Europe/Berlin');
    const cleared = await post('/me/timezone', { timezone: '' }, cookie);
    expect(cleared.headers.get('location')).toContain(encodeURIComponent("Following each standup's timezone."));
    expect(await repo.getUserTimezone('users/42')).toBeNull();
  });
});
