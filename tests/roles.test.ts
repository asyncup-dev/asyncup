import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { BUILT_IN_ROLES } from '../src/core/permissions.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const SECRET = 'roles-test-secret';
const OPERATOR = 'roles-operator';
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
    service: stack.service,
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = (sub: string) => `asyncup_sess=${sealSession(SECRET, newSession({ sub, email: `${sub}@o.com`, name: sub, admin: false }))}`;
  const call = (who: string | null, path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, {
      ...init,
      headers: who === null ? { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' } : { cookie: cookie(who), ...CSRF },
    });
  const send = async (who: string | null, method: string, path: string, body?: unknown) => {
    const res = await call(who, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? ((await res.json()) as any) : await res.text() };
  };
  const s = await seedStandup(stack.repo); // Alice, Bob and Carol; no admins yet
  await stack.repo.addAdmin(s.id, 'users/bob', 'Bob');
  return { ...stack, send, s };
}

afterEach(() => {
  close?.();
  close = null;
});

describe('custom roles', () => {
  it('creates, lists, changes and deletes roles, with every change logged', async () => {
    const { send } = await startServer();
    expect((await send('alice', 'GET', '/permissions')).body.permissions[0]).toEqual({ id: 'standups.view', label: 'See standups', description: expect.any(String), workspaceOnly: false });

    for (const [body, field] of [
      [{ name: '', permissions: ['export'] }, 'name'],
      [{ name: 'x'.repeat(41), permissions: ['export'] }, 'name'],
      [{ name: 'Lead', description: 'x'.repeat(201), permissions: ['export'] }, 'description'],
      [{ name: 'Lead', permissions: [] }, 'permissions'],
      [{ name: 'Lead', permissions: ['export', 'fly'] }, 'permissions'],
    ] as const) {
      expect((await send(null, 'POST', '/roles', body)).body.error.field).toBe(field);
    }
    expect((await send(null, 'POST', '/roles', { name: 'viewer', permissions: ['export'] })).status).toBe(409);

    const created = await send(null, 'POST', '/roles', { name: '  Support   lead ', description: 'Reads and exports', permissions: ['export', 'answers.view', 'export'] });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.stringMatching(/^\d+$/),
      name: 'Support lead',
      description: 'Reads and exports',
      permissions: ['standups.view', 'answers.view', 'export'],
      builtIn: false,
      grantable: true,
      workspaceOnly: false,
      grants: 0,
    });
    const id = created.body.id;
    expect((await send(null, 'POST', '/roles', { name: 'SUPPORT LEAD', permissions: ['export'] })).status).toBe(409);
    const workspaceOnly = await send(null, 'POST', '/roles', { name: 'Auditor', permissions: ['roles.manage'] });
    expect(workspaceOnly.body).toMatchObject({ permissions: ['roles.manage'], workspaceOnly: true });

    const roles = (await send(null, 'GET', '/roles')).body.roles;
    expect(roles.map((r: any) => [r.id, r.grantable])).toEqual([['admin', true], ['manager', true], ['viewer', true], ['member', false], [workspaceOnly.body.id, true], [id, true]]);

    expect((await send(null, 'PATCH', `/roles/${id}`, { name: 'Support', permissions: ['answers.view', 'blockers.view'] })).body).toMatchObject({ name: 'Support', permissions: ['standups.view', 'answers.view', 'blockers.view'] });
    expect((await send(null, 'PATCH', `/roles/${id}`, { name: 'Support', description: 'New words', permissions: ['answers.view', 'blockers.view'] })).body.description).toBe('New words');
    expect((await send(null, 'PATCH', `/roles/${id}`, { name: 'Auditor', permissions: ['export'] })).status).toBe(409);
    expect((await send(null, 'PATCH', '/roles/viewer', { name: 'Viewer', permissions: ['export'] })).body.error.code).toBe('built_in');
    expect((await send(null, 'PATCH', '/roles/constructor', { name: 'X', permissions: ['export'] })).status).toBe(404);
    expect((await send(null, 'PATCH', '/roles/999', { name: 'X', permissions: ['export'] })).status).toBe(404);
    expect((await send(null, 'PATCH', `/roles/${id}`, { name: '', permissions: ['export'] })).status).toBe(400);

    expect((await send(null, 'DELETE', '/roles/admin')).status).toBe(400);
    expect((await send(null, 'DELETE', '/roles/999')).status).toBe(404);
    expect((await send(null, 'DELETE', `/roles/${id}`)).status).toBe(204);

    const audit = (await send(null, 'GET', '/roles/audit?limit=10')).body.entries;
    expect(audit.map((e: any) => [e.action, e.actor, e.summary])).toEqual([
      ['role.delete', 'Operator', 'Deleted role “Support”.'],
      ['role.update', 'Operator', 'Changed role “Support”: description only.'],
      ['role.update', 'Operator', 'Changed role “Support lead”: renamed to “Support”; added blockers.view; removed export.'],
      ['role.create', 'Operator', 'Created role “Auditor”: roles.manage.'],
      ['role.create', 'Operator', 'Created role “Support lead”: standups.view, answers.view, export.'],
    ]);
  });

  it('keeps role changes to people who can manage roles', async () => {
    const { send } = await startServer();
    expect((await send('bob', 'POST', '/roles', { name: 'Lead', permissions: ['export'] })).status).toBe(403);
    expect((await send('bob', 'PATCH', '/roles/1', { name: 'Lead', permissions: ['export'] })).status).toBe(403);
    expect((await send('bob', 'DELETE', '/roles/1')).status).toBe(403);
    expect((await send('bob', 'GET', '/roles/audit')).status).toBe(403);
    expect((await send('alice', 'GET', '/roles')).status).toBe(403);
    expect((await send('alice', 'GET', '/grants')).status).toBe(403);
    expect((await send('bob', 'GET', '/roles')).status).toBe(200);
  });
});

describe('grants', () => {
  it('gives a Viewer exactly the read access, and nothing more', async () => {
    const { send, s } = await startServer();
    expect((await send('erin', 'GET', `/standups/${s.id}`)).status).toBe(404);
    const granted = await send('bob', 'POST', '/grants', { email: ' ERIN@o.com ', displayName: 'Erin', role: 'viewer', standupId: s.id });
    expect(granted.status).toBe(201);
    expect(granted.body).toEqual({
      id: expect.any(Number),
      email: 'erin@o.com',
      displayName: 'Erin',
      role: { id: 'viewer', name: 'Viewer' },
      standup: { id: s.id, name: 'Daily Standup' },
      grantedBy: 'bob',
      grantedAt: expect.any(String),
    });

    const me = (await send('erin', 'GET', '/me')).body;
    expect(me).toMatchObject({ kind: 'manager', permissions: { workspace: [], standups: { [s.id]: BUILT_IN_ROLES.viewer.permissions } } });
    expect((await send('erin', 'GET', `/standups/${s.id}`)).body.permissions).toEqual({ manage: false });
    expect((await send('erin', 'GET', '/people')).status).toBe(200);
    expect((await send('erin', 'GET', `/standups/${s.id}/export.csv`)).status).toBe(200);
    expect((await send('erin', 'PATCH', `/standups/${s.id}`, { reminderMinutesBefore: 30 })).status).toBe(403);
    expect((await send('erin', 'POST', `/standups/${s.id}/participants`, { userName: 'users/zed', displayName: 'Zed' })).status).toBe(403);
    expect((await send('erin', 'GET', '/standups')).body.standups.map((x: any) => x.id)).toEqual([s.id]);
  });

  it('lets an admin grant Admin across the workspace, and checks the request', async () => {
    const { send, s } = await startServer();
    const grace = await send(null, 'POST', '/grants', { email: 'grace@o.com', role: 'admin' });
    expect(grace.body).toMatchObject({ displayName: 'grace@o.com', standup: null, grantedBy: 'Operator' });
    expect((await send('grace', 'GET', '/me')).body.kind).toBe('admin');
    expect((await send('grace', 'GET', '/settings')).status).toBe(200);

    for (const [body, status, field] of [
      [{ email: 'nope', role: 'viewer' }, 400, 'email'],
      [{ email: 'a@o.com', role: 'viewer', displayName: 'x'.repeat(201) }, 400, 'displayName'],
      [{ email: 'a@o.com', role: 'member' }, 400, 'role'],
      [{ email: 'a@o.com', role: 'viewer', standupId: 999 }, 404, 'standupId'],
      [{ email: 'a@o.com', role: 'viewer', standupId: 'x' }, 404, 'standupId'],
      [{ email: 'a@o.com', role: 'admin', standupId: s.id }, 400, 'standupId'],
      [{ email: 'grace@o.com', role: 'admin' }, 409, undefined],
    ] as const) {
      const res = await send(null, 'POST', '/grants', body);
      expect([res.status, res.body.error.field]).toEqual([status, field]);
    }
  });

  it('stops anyone handing out more than they hold', async () => {
    const { send, s, repo } = await startServer();
    const other = await repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/other', name: 'Other', timezone: s.timezone });
    // Bob manages Daily Standup only
    expect((await send('bob', 'POST', '/grants', { email: 'a@o.com', role: 'viewer' })).status).toBe(403);
    expect((await send('bob', 'POST', '/grants', { email: 'a@o.com', role: 'viewer', standupId: other.id })).status).toBe(403);
    const roster = (await send(null, 'POST', '/roles', { name: 'Roster keeper', permissions: ['people.manage'] })).body;
    await send('bob', 'POST', '/grants', { email: 'frank@o.com', role: roster.id, standupId: s.id });
    const viewer = (await send(null, 'POST', '/grants', { email: 'erin@o.com', role: 'viewer', standupId: s.id })).body;

    // Frank manages people but cannot hand out (or take away) a Viewer's reading rights
    const up = await send('frank', 'POST', '/grants', { email: 'b@o.com', role: 'viewer', standupId: s.id });
    expect([up.status, up.body.error.code]).toEqual([403, 'escalation']);
    expect((await send('frank', 'DELETE', `/grants/${viewer.id}`)).body.error.code).toBe('escalation');
    expect((await send('frank', 'POST', '/grants', { email: 'b@o.com', role: roster.id, standupId: s.id })).status).toBe(201);

    // each manager sees the grants they could change
    expect((await send('bob', 'GET', '/grants')).body.grants.map((g: any) => g.email)).toEqual(['b@o.com', 'erin@o.com', 'frank@o.com']);
    expect((await send(null, 'GET', `/grants?standupId=${other.id}`)).body.grants).toEqual([]);
    expect((await send('bob', 'DELETE', `/grants/${viewer.id}`)).status).toBe(204);
    expect((await send('bob', 'DELETE', `/grants/${viewer.id}`)).status).toBe(404);
    expect((await send(null, 'DELETE', `/roles/${roster.id}`)).body.error.code).toBe('in_use');
  });

  it('never lets someone remove their own way to manage roles', async () => {
    const { send } = await startServer();
    const keeper = (await send(null, 'POST', '/roles', { name: 'Access keeper', permissions: ['roles.manage', 'settings.manage'] })).body;
    const mine = (await send(null, 'POST', '/grants', { email: 'grace@o.com', role: keeper.id })).body;
    const spare = (await send(null, 'POST', '/grants', { email: 'grace@o.com', role: 'viewer' })).body;

    expect((await send('grace', 'DELETE', `/grants/${mine.id}`)).body.error.code).toBe('lockout');
    expect((await send('grace', 'PATCH', `/roles/${keeper.id}`, { name: 'Access keeper', permissions: ['settings.manage'] })).body.error.code).toBe('lockout');
    expect((await send('grace', 'DELETE', `/grants/${spare.id}`)).status).toBe(204); // not her role-managing grant
    // a second source makes it safe; the operator is never locked out
    await send(null, 'POST', '/grants', { email: 'grace@o.com', role: 'admin' });
    expect((await send('grace', 'DELETE', `/grants/${mine.id}`)).status).toBe(204);
    const hers = (await send(null, 'GET', '/grants')).body.grants[0];
    expect((await send(null, 'DELETE', `/grants/${hers.id}`)).status).toBe(204);

    const audit = (await send(null, 'GET', '/roles/audit')).body.entries.map((e: any) => e.summary);
    expect(audit.slice(0, 3)).toEqual([
      'Revoked Admin from grace@o.com across the workspace.',
      'Revoked Access keeper from grace@o.com across the workspace.',
      'Granted Admin to grace@o.com across the workspace.',
    ]);
  });

  it('reaches Chat commands through the person’s email, and goes with a deleted standup', async () => {
    const { send, s, repo, commands } = await startServer();
    await repo.setUserEmail('users/dan', 'dan@o.com');
    const ctx = { tenantId: TENANT, spaceName: 'spaces/team', text: 'time 08:00', mentions: [], sender: { userName: 'users/dan', displayName: 'Dan' } };
    expect(await commands.handle(ctx)).toContain('🔒');
    await send(null, 'POST', '/grants', { email: 'dan@o.com', role: 'manager', standupId: s.id });
    expect(await commands.handle(ctx)).toContain('08:00');

    await repo.updateStandup(s.id, { active: false });
    await repo.deleteStandup(s.id);
    expect(await repo.listGrants(TENANT)).toEqual([]);
  });
});
