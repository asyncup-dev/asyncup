import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { createServer } from '../src/server.js';
import { ANSWERS, makeStack, seedStandup, TENANT, withBlocker } from './helpers.js';

const SECRET = 'api-test-secret';
const OPERATOR = 'dash-secret';
const CSRF = { 'x-requested-with': 'asyncup', 'content-type': 'application/json' };
let close: (() => void) | null = null;

async function startServer() {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router,
    scheduler: stack.scheduler,
    adapter: stack.adapter,
    blockers: stack.blockers,
    repo: stack.repo,
    settings: stack.settings,
    dashboardToken: OPERATOR,
    skipVerification: true,
    secretKey: SECRET,
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookieFor = (sub: string, name = sub) =>
    `asyncup_sess=${sealSession(SECRET, newSession({ sub, email: `${sub}@o.com`, name, admin: false }))}`;
  const op = (path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    });
  const as = (cookie: string, path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, { ...init, headers: { cookie, ...CSRF, ...(init.headers as Record<string, string>) } });
  const json = (body: unknown) => JSON.stringify(body);
  /** Opens today's run (Wed 10 Jun 2026) and returns it. */
  const openRun = async (standupId: number) => {
    stack.clock.set('2026-06-10T09:30');
    await stack.scheduler.tick();
    return (await stack.repo.getRun(standupId, '2026-06-10'))!;
  };
  return { ...stack, url, cookieFor, op, as, json, openRun };
}

afterEach(() => {
  close?.();
  close = null;
});

describe('api: standup configuration', () => {
  it('applies a partial PATCH and reports the first invalid field', async () => {
    const { op, json, repo } = await startServer();
    const s = await seedStandup(repo);
    const patch = (body: unknown) => op(`/standups/${s.id}`, { method: 'PATCH', body: json(body) });

    const ok = await patch({ name: '  Platform  ', days: ['mon', 'wed'], questions: ['Q1', ' Q2 '], moodAnonymous: true, webhookUrl: null, escalateUserName: 'users/bob' });
    expect(ok.status).toBe(200);
    const body = await ok.json() as any;
    expect(body.name).toBe('Platform');
    expect(body.schedule.days).toEqual(['mon', 'wed']);
    expect(body.questions).toEqual(['Q1', 'Q2']);
    expect(body.mood.anonymous).toBe(true);
    expect(body.escalation.contact).toEqual({ userName: 'users/bob', displayName: 'Bob' });
    // untouched fields survive a partial update
    expect(body.schedule.promptTime).toBe('09:30');

    const cases: [unknown, string][] = [
      [{ name: '  ' }, 'name'],
      [{ promptTime: '9:30' }, 'promptTime'],
      [{ deadlineTime: '25:00' }, 'deadlineTime'],
      [{ deadlineTime: '09:00' }, 'promptTime'], // prompt 09:30 must stay before the deadline
      [{ timezone: 'Mars/Olympus' }, 'timezone'],
      [{ reminderMinutesBefore: 99999 }, 'reminderMinutesBefore'],
      [{ escalateAfterDays: 0 }, 'escalateAfterDays'],
      [{ days: 'funday' }, 'days'],
      [{ webhookUrl: 'http://insecure' }, 'webhookUrl'],
      [{ questions: [] }, 'questions'],
      [{ questions: 'not a list' }, 'questions'],
      [{ questions: ['x'.repeat(201)] }, 'questions'],
      [{ digestEnabled: 'yes' }, 'digestEnabled'],
      [{ escalateUserName: 'users/nobody' }, 'escalateUserName'],
    ];
    for (const [input, field] of cases) {
      const res = await patch(input);
      expect(res.status).toBe(400);
      const err = (await res.json() as any).error;
      expect(err.code).toBe('invalid');
      expect(err.field).toBe(field);
    }
    // escalation off, webhook on, times together
    const more = await patch({ escalateUserName: null, webhookUrl: 'https://hooks.example/x', promptTime: '08:00', deadlineTime: '10:00', reminderMinutesBefore: 15, escalateAfterDays: 3, timezone: 'UTC', moodEnabled: false, digestEnabled: true });
    expect(more.status).toBe(200);
    const m = await more.json() as any;
    expect(m.escalation).toEqual({ afterDays: 3, contact: null });
    expect(m.webhook.configured).toBe(true);
    expect(m.schedule).toMatchObject({ promptTime: '08:00', deadlineTime: '10:00', timezone: 'UTC', reminderMinutesBefore: 15 });
    expect(m.mood.enabled).toBe(false);
    expect(m.digestEnabled).toBe(true);
  });

  it('refuses management routes to plain members and archives/unarchives for managers', async () => {
    const { op, as, cookieFor, repo } = await startServer();
    const s = await seedStandup(repo);
    const bob = cookieFor('bob');
    const refused = await as(bob, `/standups/${s.id}`, { method: 'PATCH', body: '{}' });
    expect(refused.status).toBe(403);
    expect((await refused.json() as any).error.code).toBe('forbidden');

    expect(await (await op(`/standups/${s.id}/archive`, { method: 'POST' })).json()).toEqual({ id: s.id, active: false });
    expect((await (await op('/standups')).json() as any).standups).toEqual([]);
    expect(await (await op(`/standups/${s.id}/unarchive`, { method: 'POST' })).json()).toEqual({ id: s.id, active: true });
  });
});

describe('api: runs', () => {
  it('runs now, nudges the people still expected, and lists recent runs', async () => {
    const { op, repo, adapter, service, clock } = await startServer();
    const s = await seedStandup(repo);
    expect((await (await op(`/standups/${s.id}/nudge`, { method: 'POST' })).json() as any).error.code).toBe('no_open_run');

    clock.set('2026-06-10T09:30');
    expect(await (await op(`/standups/${s.id}/run-now`, { method: 'POST' })).json()).toEqual({ result: 'started' });
    const run = (await repo.getRun(s.id, '2026-06-10'))!;
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);

    const nudged = await (await op(`/standups/${s.id}/nudge`, { method: 'POST' })).json() as any;
    expect(nudged.nudged.map((p: any) => p.userName)).toEqual(['users/bob', 'users/carol']);
    expect(adapter.dms.filter((d) => d.kind === 'reminder').map((d) => d.userName)).toEqual(['users/bob', 'users/carol']);

    const runs = await (await op(`/standups/${s.id}/runs?limit=5`)).json() as any;
    expect(runs.runs).toEqual([{ date: '2026-06-10', status: 'open', submitted: 1, expected: 3, missing: [{ userName: 'users/bob', displayName: 'Bob' }] }]);
  });

  it('serves today for polling, including away people and anonymous team mood', async () => {
    const { op, repo, service, openRun, clock } = await startServer();
    const s = await seedStandup(repo);
    const empty = await (await op(`/standups/${s.id}/runs/today`)).json() as any;
    expect(empty).toEqual({ date: clock.now().setZone(s.timezone).toISODate(), status: null, expected: 0, submitted: [], waiting: [], away: [], teamMood: null });

    await repo.setParticipantVacation(s.id, 'users/carol', true);
    const run = await openRun(s.id);
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);

    let today = await (await op(`/standups/${s.id}/runs/today`)).json() as any;
    expect(today.waiting).toEqual([{ userName: 'users/bob', displayName: 'Bob', mandatory: true, remindedAt: null }]);

    await service.skipToday(run.id, 'users/bob');
    today = await (await op(`/standups/${s.id}/runs/today`)).json() as any;
    expect(today.status).toBe('open');
    expect(today.expected).toBe(1);
    expect(today.submitted).toEqual([{ userName: 'users/alice', displayName: 'Alice', submittedAt: expect.any(String), late: false, mood: 'good' }]);
    expect(today.waiting).toEqual([]);
    expect(today.away.map((a: any) => [a.userName, a.reason])).toEqual([['users/bob', 'skipped'], ['users/carol', 'vacation']]);
    expect(today.teamMood).toBeNull();

    await repo.updateStandup(s.id, { moodAnonymous: true });
    today = await (await op(`/standups/${s.id}/runs/today`)).json() as any;
    expect(today.submitted[0].mood).toBeNull();
    expect(today.teamMood).toBe(4);
  });

  it('serves a run by date with submissions, and validates the date', async () => {
    const { op, repo, service, openRun } = await startServer();
    const s = await seedStandup(repo);
    const run = await openRun(s.id);
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);

    expect((await op(`/standups/${s.id}/runs/yesterday`)).status).toBe(400);
    expect((await op(`/standups/${s.id}/runs/2026-06-09`)).status).toBe(404);
    const day = await (await op(`/standups/${s.id}/runs/2026-06-10`)).json() as any;
    expect(day.submitted).toBe(1);
    expect(day.missing.map((p: any) => p.userName)).toEqual(['users/bob']);
    expect(day.submissions[0]).toMatchObject({ userName: 'users/alice', mood: 'good', answers: ANSWERS.answers });
    expect(day.teamMood).toBeNull();

    await repo.updateStandup(s.id, { moodAnonymous: true });
    const anon = await (await op(`/standups/${s.id}/runs/2026-06-10`)).json() as any;
    expect(anon.submissions[0].mood).toBeNull();
    expect(anon.teamMood).toBe(4);
  });

  it('serves insights and CSV export', async () => {
    const { op, repo, service, openRun } = await startServer();
    const s = await seedStandup(repo);
    const run = await openRun(s.id);
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    const insights = await (await op(`/standups/${s.id}/insights?weeks=2`)).json() as any;
    expect(insights.weeks).toHaveLength(2);
    expect(insights.weeks[1].participationPct).toBe(50); // 1 of 2 mandatory people

    const csv = await op(`/standups/${s.id}/export.csv?days=7`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain(`standup-${s.id}-last-7d.csv`);
    expect(await csv.text()).toContain('Shipped the auth refactor');
  });
});

describe('api: roster', () => {
  it('adds, updates and removes participants with the same rules as chat', async () => {
    const { op, json, repo, adapter } = await startServer();
    const s = await seedStandup(repo);
    const add = (body: unknown) => op(`/standups/${s.id}/participants`, { method: 'POST', body: json(body) });
    expect((await (await add({ userName: 'dave', displayName: 'Dave' })).json() as any).error.field).toBe('userName');
    expect((await (await add({ userName: 'users/dave', displayName: '' })).json() as any).error.field).toBe('displayName');
    adapter.unreachable.add('users/dave');
    const created = await add({ userName: 'users/dave', displayName: 'Dave', mandatory: false });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ userName: 'users/dave', displayName: 'Dave', mandatory: false, reachable: false });

    // Resource names contain a slash, so they travel URL-encoded.
    const patch = (who: string, body: unknown) => op(`/standups/${s.id}/participants/${encodeURIComponent(who)}`, { method: 'PATCH', body: json(body) });
    expect((await patch('users/zoe', {})).status).toBe(404);
    expect((await (await patch('users/dave', { admin: 'yes' })).json() as any).error.field).toBe('admin');
    expect(await (await patch('users/dave', { mandatory: true, onVacation: true, admin: true })).json()).toEqual({
      userName: 'users/dave', displayName: 'Dave', mandatory: true, onVacation: true, admin: true,
    });
    const last = await patch('users/dave', { admin: false });
    expect(last.status).toBe(409);
    expect((await last.json() as any).error.code).toBe('last_admin');
    await repo.addAdmin(s.id, 'users/alice', 'Alice');
    expect((await (await patch('users/dave', { admin: false })).json() as any).admin).toBe(false);

    expect((await op(`/standups/${s.id}/participants/${encodeURIComponent('users/zoe')}`, { method: 'DELETE' })).status).toBe(404);
    expect((await op(`/standups/${s.id}/participants/${encodeURIComponent('users/dave')}`, { method: 'DELETE' })).status).toBe(204);
    expect((await repo.listParticipants(s.id)).map((p) => p.userName)).not.toContain('users/dave');
  });
});

describe('api: blockers', () => {
  async function seedBlockers(t: Awaited<ReturnType<typeof startServer>>) {
    const s = await seedStandup(t.repo);
    const run = await t.openRun(s.id);
    await t.service.submit(run.id, 'users/alice', 'Alice', withBlocker('Waiting on API keys'));
    await t.service.submit(run.id, 'users/bob', 'Bob', withBlocker('CI is slow'));
    const [aliceB, bobB] = await t.repo.listOpenBlockers(s.id);
    await t.blockers.tag(s, aliceB!.id, [{ userName: 'users/bob', displayName: 'Bob' }], { userName: 'users/alice', displayName: 'Alice' });
    return { s, aliceB: aliceB!, bobB: bobB! };
  }

  it('lists blockers across the tenant with status, standup and owner filters', async () => {
    const t = await startServer();
    const { aliceB, bobB } = await seedBlockers(t);
    const other = await t.repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/o', name: 'Other', timezone: 'UTC' });

    expect((await t.op('/blockers?status=weird')).status).toBe(400);
    let list = (await (await t.op('/blockers')).json() as any).blockers;
    expect(list.map((b: any) => [b.id, b.status, b.standup.name])).toEqual([[aliceB.id, 'open', 'Daily Standup'], [bobB.id, 'open', 'Daily Standup']]);
    expect(list[0].tags).toEqual([{ userName: 'users/bob', displayName: 'Bob', acknowledgedAt: null }]);

    expect((await (await t.op(`/blockers?standupId=${other.id}`)).json() as any).blockers).toEqual([]);
    expect((await (await t.op('/blockers?owner=users/bob')).json() as any).blockers.map((b: any) => b.id)).toEqual([bobB.id]);
    expect((await (await t.op('/blockers?status=acknowledged')).json() as any).blockers).toEqual([]);

    // Bob acknowledges through the API; Alice's blocker becomes "acknowledged".
    const bob = t.cookieFor('bob', 'Bob');
    expect(await (await t.as(bob, `/blockers/${aliceB.id}/acknowledge`, { method: 'POST' })).json()).toEqual({ result: 'acked' });
    list = (await (await t.op('/blockers?status=acknowledged')).json() as any).blockers;
    expect(list.map((b: any) => b.id)).toEqual([aliceB.id]);
    expect((await (await t.op('/blockers?status=all')).json() as any).blockers).toHaveLength(2);

    // Members only see their own standups' blockers.
    const dave = t.cookieFor('dave', 'Dave');
    expect((await (await t.as(dave, '/blockers')).json() as any).blockers).toEqual([]);
  });

  it('acknowledges, updates and resolves with the chat rules, and needs a person', async () => {
    const t = await startServer();
    const { aliceB, bobB } = await seedBlockers(t);
    const alice = t.cookieFor('alice', 'Alice');
    const bob = t.cookieFor('bob', 'Bob');
    const carol = t.cookieFor('carol', 'Carol');
    const post = (cookie: string, path: string, body?: unknown) => t.as(cookie, path, { method: 'POST', body: body ? t.json(body) : undefined });

    const token = await t.op(`/blockers/${aliceB.id}/acknowledge`, { method: 'POST' });
    expect((await token.json() as any).error.code).toBe('needs_user');
    expect((await post(alice, '/blockers/999/acknowledge')).status).toBe(404);
    expect((await (await post(carol, `/blockers/${aliceB.id}/acknowledge`)).json() as any).error.code).toBe('not_tagged');
    expect(await (await post(bob, `/blockers/${aliceB.id}/acknowledge`)).json()).toEqual({ result: 'acked' });
    expect((await (await post(bob, `/blockers/${aliceB.id}/acknowledge`)).json() as any).error.code).toBe('already_acknowledged');

    expect((await (await post(bob, `/blockers/${aliceB.id}/update`, { text: '' })).json() as any).error.field).toBe('text');
    expect(await (await post(bob, `/blockers/${aliceB.id}/update`, { text: 'Raised PLAT-412' })).json()).toEqual({ result: 'ok' });
    const listed = (await (await t.op('/blockers')).json() as any).blockers.find((b: any) => b.id === aliceB.id);
    expect(listed.updates).toEqual([{ userName: 'users/bob', displayName: 'Bob', text: 'Raised PLAT-412', at: expect.any(String) }]);

    expect((await (await post(carol, `/blockers/${bobB.id}/resolve`)).json() as any).error.code).toBe('not_allowed');
    expect(await (await post(bob, `/blockers/${bobB.id}/resolve`)).json()).toEqual({ result: 'resolved' });
    expect((await (await post(bob, `/blockers/${bobB.id}/resolve`)).json() as any).error.code).toBe('resolved');
    expect((await (await post(bob, `/blockers/${bobB.id}/update`, { text: 'late' })).json() as any).error.code).toBe('resolved');
    expect((await (await post(bob, `/blockers/${bobB.id}/acknowledge`)).json() as any).error.code).toBe('not_found');

    // A person outside the standup cannot even see the blocker.
    const dave = t.cookieFor('dave', 'Dave');
    expect((await post(dave, `/blockers/${aliceB.id}/resolve`)).status).toBe(404);
  });
});

describe('api: people', () => {
  it('lists the directory for admins and managers, scoped, never for members', async () => {
    const { op, as, cookieFor, repo } = await startServer();
    const s = await seedStandup(repo);
    const other = await repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/o', name: 'Other', timezone: 'UTC' });
    await repo.upsertParticipant({ standupId: other.id, userName: 'users/alice', displayName: 'Alice' });
    await repo.upsertParticipant({ standupId: other.id, userName: 'users/dave', displayName: 'Dave' });
    await repo.addAdmin(other.id, 'users/dave', 'Dave');
    await repo.setUserEmail('users/alice', 'alice@o.com');
    await repo.setParticipantVacation(other.id, 'users/alice', true);

    expect((await as(cookieFor('bob'), '/people')).status).toBe(403);

    const all = (await (await op('/people')).json() as any).people;
    expect(all.map((p: any) => p.userName)).toEqual(['users/alice', 'users/bob', 'users/carol', 'users/dave']);
    const alice = all.find((p: any) => p.userName === 'users/alice');
    expect(alice).toMatchObject({ email: 'alice@o.com', onVacation: true });
    expect(alice.standups).toEqual([
      { id: s.id, name: 'Daily Standup', mandatory: true, admin: false },
      { id: other.id, name: 'Other', mandatory: true, admin: false },
    ]);
    expect(all.find((p: any) => p.userName === 'users/dave').standups[0].admin).toBe(true);

    // Dave manages "Other" only: he sees its roster, not the daily standup's.
    const mine = (await (await as(cookieFor('dave'), '/people')).json() as any).people;
    expect(mine.map((p: any) => p.userName)).toEqual(['users/alice', 'users/dave']);
    expect(mine[0].standups.map((x: any) => x.id)).toEqual([other.id]);
  });
});

describe('api: member', () => {
  it('shows my standups and answers, and updates my settings', async () => {
    const { as, op, cookieFor, json, repo, service, openRun, clock, scheduler } = await startServer();
    const s = await seedStandup(repo);
    const unlinked = cookieFor('', 'Nobody');
    expect(await (await as(unlinked, '/me/standups')).json()).toEqual({ linked: false, standups: [] });
    expect(await (await as(unlinked, '/me/submissions')).json()).toEqual({ submissions: [] });
    expect((await (await as(unlinked, '/me', { method: 'PATCH', body: '{}' })).json() as any).error.code).toBe('not_linked');
    expect((await (await op('/me', { method: 'PATCH', body: '{}' })).json() as any).error.code).toBe('not_linked');

    const alice = cookieFor('alice', 'Alice');
    let mine = await (await as(alice, '/me/standups')).json() as any;
    expect(mine.linked).toBe(true);
    expect(mine.standups[0]).toMatchObject({ id: s.id, today: null, progress: null, mandatory: true, onVacation: false });
    expect(mine).toMatchObject({ timezone: null, chat: { dmUrl: null } });
    await repo.setDmSpace('users/alice', 'spaces/dm-alice');
    expect((await (await as(alice, '/me/standups')).json() as any).chat.dmUrl).toBe('https://chat.google.com/dm/dm-alice');

    const run = await openRun(s.id);
    mine = await (await as(alice, '/me/standups')).json() as any;
    expect(mine.standups[0]).toMatchObject({ today: 'waiting', progress: { submitted: 0, expected: 3 } });
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    expect((await (await as(alice, '/me/standups')).json() as any).standups[0].today).toBe('submitted');
    const bob = cookieFor('bob', 'Bob');
    clock.set('2026-06-10T11:30');
    await scheduler.tick();
    expect((await (await as(bob, '/me/standups')).json() as any).standups[0].today).toBe('closed');

    const subs = await (await as(alice, '/me/submissions?limit=5')).json() as any;
    expect(subs.submissions).toEqual([{ date: '2026-06-10', standupName: 'Daily Standup', submittedAt: expect.any(String), editedAt: null, late: false, mood: 'good', answers: ANSWERS.answers }]);

    const patch = (body: unknown) => as(alice, '/me', { method: 'PATCH', body: json(body) });
    expect((await (await patch({ onVacation: 'yes' })).json() as any).error.field).toBe('onVacation');
    expect((await (await patch({ timezone: 'Nowhere/City' })).json() as any).error.field).toBe('timezone');
    expect(await (await patch({ timezone: 'Europe/Berlin', onVacation: true })).json()).toEqual({ timezone: 'Europe/Berlin', onVacation: true });
    expect(await (await patch({ timezone: null, onVacation: false })).json()).toEqual({ timezone: null, onVacation: false });
    expect(await (await patch({})).json()).toEqual({ timezone: null, onVacation: false });
  });
});
