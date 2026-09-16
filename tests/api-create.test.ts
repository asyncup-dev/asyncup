import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { createServer } from '../src/server.js';
import { DEFAULT_QUESTIONS } from '../src/core/types.js';
import { TEMPLATES } from '../src/core/templates.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

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
  const cookieFor = (sub: string, admin = false) =>
    `asyncup_sess=${sealSession(SECRET, newSession({ sub, email: `${sub}@o.com`, name: sub, admin }))}`;
  const op = (path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    });
  const as = (cookie: string, path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, { ...init, headers: { cookie, ...CSRF, ...(init.headers as Record<string, string>) } });
  const create = (body: unknown, cookie?: string) =>
    cookie
      ? as(cookie, '/standups', { method: 'POST', body: JSON.stringify(body) })
      : op('/standups', { method: 'POST', body: JSON.stringify(body) });
  return { ...stack, url, cookieFor, op, as, create };
}

afterEach(() => {
  close?.();
  close = null;
});

const ROSTER = [
  { userName: 'users/asha', displayName: 'Asha' },
  { userName: 'users/rohit', displayName: 'Rohit', mandatory: false },
];

describe('api: templates and spaces', () => {
  it('lists the template gallery to anyone signed in', async () => {
    const { as, cookieFor } = await startServer();
    const body = await (await as(cookieFor('alice'), '/templates')).json() as any;
    expect(body.templates.map((t: any) => t.id)).toEqual(TEMPLATES.map((t) => t.id));
    expect(body.templates[0]).toMatchObject({ id: 'daily-standup', questions: [...DEFAULT_QUESTIONS] });
  });

  it('shows admins the spaces the app is in, with the standups already reporting there', async () => {
    const { op, as, cookieFor, adapter, repo } = await startServer();
    expect((await as(cookieFor('alice'), '/spaces')).status).toBe(403);
    adapter.spaces = [
      { name: 'spaces/team', displayName: 'Team' },
      { name: 'spaces/empty', displayName: 'Empty' },
    ];
    const s = await seedStandup(repo);
    const body = await (await op('/spaces')).json() as any;
    expect(body.spaces).toEqual([
      { name: 'spaces/team', displayName: 'Team', standups: [{ id: s.id, name: 'Daily Standup' }] },
      { name: 'spaces/empty', displayName: 'Empty', standups: [] },
    ]);

    adapter.listSpaces = async () => {
      throw new Error('invalid_grant');
    };
    const failed = await op('/spaces');
    expect(failed.status).toBe(502);
    expect((await failed.json() as any).error).toMatchObject({ code: 'chat_unavailable', message: expect.stringContaining('invalid_grant') });
  });

  it('suggests a space’s human members', async () => {
    const { op, as, cookieFor, adapter } = await startServer();
    const path = `/spaces/${encodeURIComponent('spaces/team')}/members`;
    expect((await as(cookieFor('alice'), path)).status).toBe(403);
    expect((await op('/spaces/nope/members')).status).toBe(400);
    adapter.members.set('spaces/team', ROSTER.map(({ userName, displayName }) => ({ userName, displayName })));
    expect((await (await op(path)).json() as any).members).toEqual([
      { userName: 'users/asha', displayName: 'Asha' },
      { userName: 'users/rohit', displayName: 'Rohit' },
    ]);
    expect((await (await op(`/spaces/${encodeURIComponent('spaces/other')}/members`)).json() as any).members).toEqual([]);
    adapter.listSpaceMembers = async () => {
      throw 'quota';
    };
    const failed = await op(path);
    expect(failed.status).toBe(502);
    expect((await failed.json() as any).error.message).toContain('quota');
  });
});

describe('api: create standup', () => {
  it('is admin-only', async () => {
    const { create, cookieFor, repo } = await startServer();
    const s = await seedStandup(repo);
    await repo.addAdmin(s.id, 'users/alice', 'Alice');
    expect((await create({ name: 'X', spaceName: 'spaces/team' }, cookieFor('alice'))).status).toBe(403);
    expect((await create({ name: 'X', spaceName: 'spaces/team' }, cookieFor('bob'))).status).toBe(403);
  });

  it('validates the request and names the field', async () => {
    const { create } = await startServer();
    const cases: [unknown, string][] = [
      [{ spaceName: 'spaces/team' }, 'name'],
      [{ name: 'x'.repeat(201), spaceName: 'spaces/team' }, 'name'],
      [{ name: 'Eng' }, 'spaceName'],
      [{ name: 'Eng', spaceName: 'team' }, 'spaceName'],
      [{ name: 'Eng', spaceName: 'spaces/team', templateId: 'nope' }, 'templateId'],
      [{ name: 'Eng', spaceName: 'spaces/team', participants: 'alice' }, 'participants'],
      [{ name: 'Eng', spaceName: 'spaces/team', participants: [{ userName: 'alice', displayName: 'A' }] }, 'participants'],
      [{ name: 'Eng', spaceName: 'spaces/team', participants: [{ userName: 'users/a' }] }, 'participants'],
      [{ name: 'Eng', spaceName: 'spaces/team', promptTime: '25:00' }, 'promptTime'],
      [{ name: 'Eng', spaceName: 'spaces/team', questions: [] }, 'questions'],
    ];
    for (const [body, field] of cases) {
      const res = await create(body);
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toMatchObject({ code: 'invalid', field });
    }
  });

  it('refuses a duplicate name in the same space, case-insensitively', async () => {
    const { create, repo } = await startServer();
    const s = await seedStandup(repo);
    const res = await create({ name: 'daily standup', spaceName: 'spaces/team' });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toMatchObject({ code: 'duplicate', message: expect.stringContaining(`#${s.id}`) });
    expect((await create({ name: 'Daily Standup', spaceName: 'spaces/other' })).status).toBe(201);
  });

  it('seeds from a template, lets explicit values win, and can open the first run', async () => {
    const { create, repo, adapter, clock } = await startServer();
    clock.set('2026-06-12T14:00'); // a Friday, inside the retro window once it opens
    const res = await create({
      templateId: 'weekly-retro',
      name: '  Retro  ',
      spaceName: 'spaces/team',
      participants: [...ROSTER, ROSTER[0]],
      digestEnabled: true,
      runNow: true,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      name: 'Retro',
      template: 'weekly-retro',
      schedule: { promptTime: '15:00', deadlineTime: '17:00', days: ['fri'], timezone: 'Asia/Kolkata' },
      questions: ['What went well this week?', 'What did not go well?', 'What will you change next week?'],
      mood: { enabled: true, anonymous: true },
      digestEnabled: true,
      admins: [],
      runNow: 'started',
    });
    expect(body.participants).toEqual([
      expect.objectContaining({ userName: 'users/asha', mandatory: true }),
      expect.objectContaining({ userName: 'users/rohit', mandatory: false }),
    ]);
    expect(adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName).sort()).toEqual(['users/asha', 'users/rohit']);
    expect(await repo.listStandupsBySpace(TENANT, 'spaces/team')).toHaveLength(1);
  });

  it('keeps the database defaults for the blank template and for no template', async () => {
    const { create } = await startServer();
    const blank = await (await create({ templateId: 'blank', name: 'A', spaceName: 'spaces/a' })).json() as any;
    expect(blank).toMatchObject({ template: 'blank', questions: [...DEFAULT_QUESTIONS], schedule: { promptTime: '09:30' }, runNow: null });
    const none = await (await create({ templateId: null, name: 'B', spaceName: 'spaces/b', questions: ['Only one?'] })).json() as any;
    expect(none).toMatchObject({ template: null, questions: ['Only one?'], mood: { enabled: true, anonymous: false } });
    expect(none.people).toEqual({ total: 0, mandatory: 0 });
  });

  it('makes a signed-in admin the standup admin; the operator token leaves it open', async () => {
    const { create, cookieFor, repo } = await startServer();
    const mine = await (await create({ name: 'Mine', spaceName: 'spaces/x' }, cookieFor('root', true))).json() as any;
    expect(mine.admins).toEqual([{ userName: 'users/root', displayName: 'root' }]);
    expect(await repo.isAdmin(mine.id, 'users/root')).toBe(true);
    const open = await (await create({ name: 'Open', spaceName: 'spaces/x', runNow: true })).json() as any;
    expect(open.admins).toEqual([]);
    expect(open.runNow).toBe('no_participants');
  });
});
