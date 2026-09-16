import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT, withBlocker } from './helpers.js';

const SECRET = 'api-test-secret';
const OPERATOR = 'dash-secret';
const CSRF = { 'x-requested-with': 'asyncup', 'content-type': 'application/json' };
let close: (() => void) | null = null;
const clients: Client[] = [];

async function startServer(opts: { withoutService?: boolean; enabled?: boolean } = {}) {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router,
    scheduler: stack.scheduler,
    adapter: stack.adapter,
    blockers: stack.blockers,
    repo: stack.repo,
    settings: stack.settings,
    ...(opts.withoutService ? {} : { service: stack.service }),
    dashboardToken: OPERATOR,
    skipVerification: true,
    secretKey: SECRET,
    now: stack.clock.now,
  });
  if (opts.enabled !== false) await stack.settings.update({ mcpEnabled: true });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookieFor = (sub: string, admin = false) =>
    `asyncup_sess=${sealSession(SECRET, newSession({ sub, email: `${sub || 'saml'}@o.com`, name: sub || 'Sam', admin }))}`;
  const op = (path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
  const as = (cookie: string, path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, { ...init, headers: { cookie, ...CSRF, ...(init.headers as Record<string, string>) } });
  /** Mint a token through the API and return its secret. */
  const mint = async (who: string | null, body: unknown = { name: 'laptop' }) => {
    const res = who ? await as(who, '/mcp/tokens', { method: 'POST', body: JSON.stringify(body) }) : await op('/mcp/tokens', { method: 'POST', body: JSON.stringify(body) });
    expect(res.status).toBe(201);
    return (await res.json()) as any;
  };
  const connect = async (secret: string) => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${secret}` } } }));
    clients.push(client);
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as any;
    const text = r.content[0].text as string;
    return r.isError ? { error: text, json: null } : { error: null, json: JSON.parse(text) };
  };
  const raw = (headers: Record<string, string> = {}) =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
  /** Opens today's run (Wed 10 Jun 2026) and returns it. */
  const openRun = async (standupId: number) => {
    stack.clock.set('2026-06-10T09:30');
    await stack.scheduler.tick();
    return (await stack.repo.getRun(standupId, '2026-06-10'))!;
  };
  return { ...stack, url, cookieFor, op, as, mint, connect, call, raw, openRun };
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  close?.();
  close = null;
});

const ALICE = { userName: 'users/alice', displayName: 'Alice' };
/** Session names come from the cookie's sub, so token owners carry the lower-case form. */
const ALICE_SESSION = { userName: 'users/alice', displayName: 'alice' };
const BOB = { userName: 'users/bob', displayName: 'Bob' };
const FULL = ['read', 'blockers:write', 'submit'];

describe('mcp: endpoint gate', () => {
  it('is off by default and answers 503 until an admin enables it', async () => {
    const { raw, settings, op } = await startServer({ enabled: false });
    const off = await raw();
    expect(off.status).toBe(503);
    expect(((await off.json()) as any).error.code).toBe('mcp_disabled');
    expect(((await (await op('/settings')).json()) as any).mcp).toMatchObject({ enabled: false, defaultScopes: ['read'], endpoint: '/mcp' });

    const patch = await op('/settings', { method: 'PATCH', body: JSON.stringify({ mcpEnabled: true, mcpDefaultScopes: 'read, submit, read' }) });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as any).mcp).toMatchObject({ enabled: true, defaultScopes: ['read', 'submit'] });
    expect((await settings.get()).mcpEnabled).toBe(true);
    const bad = await op('/settings', { method: 'PATCH', body: JSON.stringify({ mcpDefaultScopes: 'read,bogus' }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.field).toBe('mcpDefaultScopes');
    expect((await raw()).status).toBe(401);
  });

  it('rejects missing, malformed, unknown, revoked, expired and foreign tokens', async () => {
    const { raw, mint, cookieFor, as, repo, clock } = await startServer();
    const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer nope' }, { authorization: 'Bearer amcp_unknown' }];
    for (const headers of attempts) {
      const res = await raw(headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
    }
    expect(((await (await raw({ authorization: 'Bearer amcp_unknown' })).json()) as any).error.message).toContain('unknown');

    const t = await mint(cookieFor('root', true));
    expect((await raw({ authorization: `Bearer ${t.secret}` })).status).toBe(200);
    expect((await as(cookieFor('root', true), `/mcp/tokens/${t.id}`, { method: 'DELETE' })).status).toBe(204);
    const revoked = await raw({ authorization: `Bearer ${t.secret}` });
    expect(((await revoked.json()) as any).error.message).toContain('revoked');

    const fresh = await mint(cookieFor('root', true), { name: 'second' });
    clock.set('2026-09-10T00:00'); // 92 days on, nothing has touched it
    expect(((await (await raw({ authorization: `Bearer ${fresh.secret}` })).json()) as any).error.message).toContain('expired');

    await repo.createMcpToken({
      tenantId: 'other',
      name: 'elsewhere',
      kind: 'service',
      ownerUserName: null,
      ownerDisplayName: null,
      ownerAdmin: false,
      scopes: 'read',
      tokenHash: (await import('../src/mcp/tokens.js')).hashMcpToken('amcp_foreign'),
      createdAt: '2026-09-10T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
    });
    expect(((await (await raw({ authorization: 'Bearer amcp_foreign' })).json()) as any).error.message).toContain('another tenant');
  });

  it('keeps a token alive while it is used (rolling expiry)', async () => {
    const { raw, mint, cookieFor, clock, repo } = await startServer();
    const t = await mint(cookieFor('root', true));
    clock.set('2026-08-01T00:00');
    expect((await raw({ authorization: `Bearer ${t.secret}` })).status).toBe(200);
    const row = (await repo.getMcpTokenById(t.id))!;
    expect(row.lastUsedAt).toBe('2026-07-31T18:30:00.000Z');
    expect(row.expiresAt).toBe('2026-10-29T18:30:00.000Z');
    clock.set('2026-10-01T00:00'); // would have expired without the July use
    expect((await raw({ authorization: `Bearer ${t.secret}` })).status).toBe(200);
  });
});

describe('mcp: token administration', () => {
  it('validates token requests', async () => {
    const { as, op, cookieFor } = await startServer();
    const alice = cookieFor('alice');
    const cases: [string | null, unknown, number, string][] = [
      [alice, {}, 400, 'invalid'],
      [alice, { name: 'x', kind: 'weird' }, 400, 'invalid'],
      [alice, { name: 'x', kind: 'service' }, 403, 'forbidden'],
      [null, { name: 'x' }, 403, 'needs_user'],
      [alice, { name: 'x', scopes: 'read' }, 400, 'invalid'],
      [alice, { name: 'x', scopes: ['read', 'admin'] }, 400, 'invalid'],
      [alice, { name: 'x', scopes: [] }, 400, 'invalid'],
      [cookieFor(''), { name: 'x' }, 403, 'needs_user'],
    ];
    for (const [who, body, status, code] of cases) {
      const res = who ? await as(who, '/mcp/tokens', { method: 'POST', body: JSON.stringify(body) }) : await op('/mcp/tokens', { method: 'POST', body: JSON.stringify(body) });
      expect(res.status).toBe(status);
      expect(((await res.json()) as any).error.code).toBe(code);
    }
  });

  it('mints, lists, scopes and revokes tokens per role', async () => {
    const { as, op, mint, cookieFor, settings, url } = await startServer();
    await settings.update({ mcpDefaultScopes: 'read,submit' });
    const alice = cookieFor('alice');
    const root = cookieFor('root', true);

    const mine = await mint(alice);
    expect(mine).toMatchObject({ name: 'laptop', kind: 'personal', owner: ALICE_SESSION, scopes: ['read', 'submit'], lastUsedAt: null, revokedAt: null });
    expect(mine.secret).toStartWith('amcp_');
    expect(mine.config).toEqual({ url: `${url}/mcp`, headers: { Authorization: `Bearer ${mine.secret}` } });

    const service = await mint(null, { name: 'ci', kind: 'service', scopes: FULL });
    expect(service).toMatchObject({ kind: 'service', owner: null, scopes: ['read'] });
    const admin = await mint(root, { name: 'root laptop', scopes: ['blockers:write'] });
    expect(admin.scopes).toEqual(['blockers:write']);

    expect(((await (await as(alice, '/mcp/tokens')).json()) as any).tokens.map((t: any) => t.name)).toEqual(['laptop']);
    expect(((await (await op('/mcp/tokens')).json()) as any).tokens.map((t: any) => t.name)).toEqual(['laptop', 'ci', 'root laptop']);
    expect(((await (await as(cookieFor(''), '/mcp/tokens')).json()) as any).tokens).toEqual([]);
    expect(JSON.stringify(await (await op('/mcp/tokens')).json())).not.toContain('amcp_');

    expect((await as(alice, `/mcp/tokens/${service.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await as(alice, `/mcp/tokens/${mine.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await as(alice, `/mcp/tokens/${mine.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await as(root, `/mcp/tokens/${service.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await op('/mcp/tokens/999', { method: 'DELETE' })).status).toBe(404);
  });

  it('verifies the setup in stages', async () => {
    const { op, as, mint, cookieFor, connect, call, settings } = await startServer({ enabled: false });
    expect((await as(cookieFor('alice'), '/verify/mcp', { method: 'POST' })).status).toBe(403);
    const verify = async () => (await (await op('/verify/mcp', { method: 'POST' })).json()) as any;
    expect((await verify()).detail).toContain('switched off');
    await settings.update({ mcpEnabled: true });
    expect((await verify()).detail).toContain('no token exists');
    const t = await mint(cookieFor('root', true));
    let v = await verify();
    expect(v).toMatchObject({ state: 'pass', data: { tokens: 1, lastActivityAt: null } });
    expect(v.detail).toContain('no client has called it yet');
    await call(await connect(t.secret), 'list_standups');
    v = await verify();
    expect(v.data.lastActivityAt).toEqual(expect.any(String));
    expect(v.detail).toContain('the last call was at');
  });
});

describe('mcp: tools', () => {
  it('offers tools by scope and role, and reads what the owner can see', async () => {
    const { mint, cookieFor, connect, call, repo, openRun, service } = await startServer();
    const s = await seedStandup(repo);
    const run = await openRun(s.id);
    await service.submit(run.id, ALICE.userName, ALICE.displayName, withBlocker('Waiting on API keys'));

    const alice = await connect((await mint(cookieFor('alice'), { name: 'a', scopes: FULL })).secret);
    expect(((await alice.listTools()).tools.map((t) => t.name)).sort()).toEqual(
      ['acknowledge_blocker', 'get_insights', 'get_run', 'get_team', 'list_blockers', 'list_runs', 'list_standups', 'resolve_blocker', 'submit_answers', 'update_blocker'].sort(),
    );
    const standups = (await call(alice, 'list_standups')).json.standups;
    expect(standups).toHaveLength(1);
    expect(standups[0]).toMatchObject({ id: s.id, permissions: { manage: false }, today: { status: 'open', submitted: 1 } });
    expect((await call(alice, 'get_team')).error).toContain('Only admins and managers');
    expect((await call(alice, 'list_runs', { standupId: s.id })).json.runs).toEqual([expect.objectContaining({ date: '2026-06-10', submitted: 1, expected: 3 })]);
    expect((await call(alice, 'get_run', { standupId: s.id })).json.submissions[0]).toMatchObject({ userName: 'users/alice', answers: [expect.anything(), expect.anything(), { answer: 'Waiting on API keys' }] });
    expect((await call(alice, 'get_run', { standupId: s.id, date: '2026-06-10' })).json.date).toBe('2026-06-10');
    expect((await call(alice, 'get_run', { standupId: s.id, date: '2026-06-09' })).error).toBe('No run on that date.');
    expect((await call(alice, 'get_run', { standupId: 999 })).error).toBe('No such standup.');
    expect((await call(alice, 'get_insights', { standupId: s.id, weeks: 2 })).json.weeks).toHaveLength(2);
    const blockers = (await call(alice, 'list_blockers')).json.blockers;
    expect(blockers).toEqual([expect.objectContaining({ text: 'Waiting on API keys', status: 'open', owner: ALICE })]);
    expect((await call(alice, 'list_blockers', { status: 'resolved', standupId: s.id, owner: 'users/alice' })).json.blockers).toEqual([]);

    // A manager sees the team; a Workspace admin's personal token sees the tenant.
    await repo.addAdmin(s.id, ALICE.userName, ALICE.displayName);
    expect((await call(alice, 'get_team')).json.people.map((p: any) => p.userName).sort()).toEqual(['users/alice', 'users/bob', 'users/carol']);
    expect((await call(alice, 'list_standups')).json.standups[0].permissions.manage).toBe(true);

    const root = await connect((await mint(cookieFor('root', true), { name: 'r' })).secret);
    expect((await root.listTools()).tools).toHaveLength(6);
    expect((await call(root, 'get_team')).json.people).toHaveLength(3);
  });

  it('acts as the owner on blockers and logs every call', async () => {
    const { mint, cookieFor, connect, call, repo, openRun, service, blockers, as, op } = await startServer();
    const s = await seedStandup(repo);
    const run = await openRun(s.id);
    await service.submit(run.id, ALICE.userName, ALICE.displayName, withBlocker('Waiting on API keys'));
    const blocker = (await repo.listOpenBlockers(s.id))[0]!;
    await blockers.tag(s, blocker.id, [BOB], ALICE);

    const aliceToken = await mint(cookieFor('alice'), { name: 'a', scopes: ['blockers:write'] });
    const alice = await connect(aliceToken.secret);
    const bob = await connect((await mint(cookieFor('bob'), { name: 'b', scopes: ['blockers:write'] })).secret);
    expect(((await alice.listTools()).tools.map((t) => t.name)).sort()).toEqual(['acknowledge_blocker', 'resolve_blocker', 'update_blocker']);

    expect((await call(alice, 'acknowledge_blocker', { blockerId: 999 })).error).toBe('No such blocker.');
    expect((await call(alice, 'acknowledge_blocker', { blockerId: blocker.id })).error).toContain('Only people tagged');
    expect((await call(bob, 'acknowledge_blocker', { blockerId: blocker.id })).json).toEqual({ result: 'acked' });
    expect((await call(bob, 'acknowledge_blocker', { blockerId: blocker.id })).error).toContain('already acknowledged');
    const long = 'x'.repeat(200);
    expect((await call(bob, 'update_blocker', { blockerId: blocker.id, text: long })).json).toEqual({ result: 'ok' });
    expect((await call(alice, 'resolve_blocker', { blockerId: blocker.id })).json).toEqual({ result: 'resolved' });
    expect((await call(alice, 'resolve_blocker', { blockerId: blocker.id })).error).toContain('already resolved');
    expect((await call(bob, 'update_blocker', { blockerId: blocker.id, text: 'late' })).error).toContain('already resolved');
    expect((await call(bob, 'acknowledge_blocker', { blockerId: blocker.id })).error).toBe('No such open blocker.');

    // Carol is optional on the roster and neither owner nor tagged.
    const carol = await connect((await mint(cookieFor('carol'), { name: 'c', scopes: ['blockers:write'] })).secret);
    await service.submit(run.id, BOB.userName, BOB.displayName, withBlocker('Second one'));
    const second = (await repo.listOpenBlockers(s.id))[0]!;
    expect((await call(carol, 'resolve_blocker', { blockerId: second.id })).error).toContain('Only the owner');

    const mine = ((await (await as(cookieFor('alice'), '/mcp/activity')).json()) as any).activity;
    expect(mine.map((a: any) => [a.tool, a.ok])).toEqual([
      ['resolve_blocker', false],
      ['resolve_blocker', true],
      ['acknowledge_blocker', false],
      ['acknowledge_blocker', false],
    ]);
    expect(mine[0].token).toEqual({ id: aliceToken.id, name: 'a' });
    const all = ((await (await op('/mcp/activity?limit=3')).json()) as any).activity;
    expect(all).toHaveLength(3);
    const truncated = ((await (await op('/mcp/activity?limit=50')).json()) as any).activity.find((a: any) => a.argsSummary.endsWith('…'));
    expect(truncated.argsSummary).toHaveLength(198); // 197 characters + the ellipsis
    expect(((await (await as(cookieFor('dave'), '/mcp/activity')).json()) as any).activity).toEqual([]);
  });

  it('submits today’s answers as the owner', async () => {
    const { mint, cookieFor, connect, call, repo, openRun, clock, scheduler } = await startServer();
    const s = await seedStandup(repo);
    const alice = await connect((await mint(cookieFor('alice'), { name: 'a', scopes: ['submit'] })).secret);
    const dave = await connect((await mint(cookieFor('dave'), { name: 'd', scopes: ['submit'] })).secret);
    expect((await alice.listTools()).tools.map((t) => t.name)).toEqual(['submit_answers']);

    expect((await call(alice, 'submit_answers', { standupId: s.id, answers: ['one'] })).error).toContain('asks 3 questions');
    const three = { standupId: s.id, answers: ['Shipped', 'Billing', 'none'] };
    expect((await call(alice, 'submit_answers', three)).error).toContain('not opened yet');
    await openRun(s.id);
    expect((await call(dave, 'submit_answers', three)).error).toBe('No such standup.');
    expect((await call(alice, 'submit_answers', { ...three, mood: 'good' })).json).toEqual({ result: 'submitted', date: '2026-06-10' });
    expect((await repo.getSubmission((await repo.getRun(s.id, '2026-06-10'))!.id, 'users/alice'))!.mood).toBe('good');
    // Editing before the deadline works; after wrap-up it does not.
    expect((await call(alice, 'submit_answers', { ...three, answers: ['Edited', 'Billing', 'none'] })).json.result).toBe('submitted');
    clock.set('2026-06-10T11:31');
    await scheduler.tick();
    expect((await call(alice, 'submit_answers', three)).error).toContain('closed');
    // Someone removed from the roster after the run opened is not a participant of that run.
    await repo.upsertParticipant({ standupId: s.id, userName: 'users/erin', displayName: 'Erin' });
    const erin = await connect((await mint(cookieFor('erin'), { name: 'e', scopes: ['submit'] })).secret);
    expect((await call(erin, 'submit_answers', three)).error).toContain('not on this standup’s roster today');
  });

  it('refuses write tools on a token with no person behind it, and drops submit without the service', async () => {
    const { repo, connect, call } = await startServer();
    await seedStandup(repo);
    const { hashMcpToken } = await import('../src/mcp/tokens.js');
    await repo.createMcpToken({
      tenantId: TENANT,
      name: 'hand-edited',
      kind: 'service',
      ownerUserName: null,
      ownerDisplayName: null,
      ownerAdmin: false,
      scopes: 'read,blockers:write,submit',
      tokenHash: hashMcpToken('amcp_service'),
      createdAt: '2026-06-01T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
    });
    const svc = await connect('amcp_service');
    expect((await call(svc, 'acknowledge_blocker', { blockerId: 1 })).error).toContain('no person behind it');
    expect((await call(svc, 'submit_answers', { standupId: 1, answers: ['a', 'b', 'c'] })).error).toContain('no person behind it');
    expect((await call(svc, 'list_standups')).json.standups).toHaveLength(1);
  });

  it('does not offer submit_answers when the server has no standup service', async () => {
    const { mint, cookieFor, connect } = await startServer({ withoutService: true });
    const c = await connect((await mint(cookieFor('alice'), { name: 'a', scopes: FULL })).secret);
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain('submit_answers');
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('acknowledge_blocker');
  });
});
