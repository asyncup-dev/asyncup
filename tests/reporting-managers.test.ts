import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { APPROVE_REQUEST_FN } from '../src/adapters/gchat/cards.js';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT, TZ } from './helpers.js';

const bob = { userName: 'users/bob', displayName: 'Bob' };
const neha = { userName: 'users/neha', displayName: 'Neha' };
const asSelf = (p: { userName: string; displayName: string }) => ({ ...p, admin: false });
const SECRET = 'rm-test-secret';
const OPERATOR = 'rm-operator';
const CSRF = { 'x-requested-with': 'asyncup', 'content-type': 'application/json' };
let close: (() => void) | null = null;
afterEach(() => close?.());

/** Engineering needs approval and is managed by Admin; Neha manages Platform, which Bob isn't on. */
async function world() {
  const hooks: any[] = [];
  const stack = await makeStack({ webhookFetch: (async (_url: any, init: any) => { hooks.push(JSON.parse(init.body)); return new Response('', { status: 200 }); }) as typeof fetch });
  const eng = await seedStandup(stack.repo);
  await stack.repo.updateStandup(eng.id, { timeOffPolicy: 'approval', webhookUrl: 'https://hooks.example/asyncup' });
  await stack.repo.addAdmin(eng.id, 'users/admin', 'Admin');
  const platform = await stack.repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/platform', name: 'Platform', timezone: TZ });
  await stack.repo.addAdmin(platform.id, neha.userName, neha.displayName);
  stack.clock.set('2026-06-10T10:00'); // Wednesday
  const off = (dates: string[], working = false) => stack.schedule.setOverride({ target: bob, dates, working, reason: 'sick', actor: asSelf(bob), channel: 'chat' });
  const cards = (to: string) => stack.adapter.dms.filter((d) => d.kind === 'timeOffRequest' && d.userName === to);
  const pendingIds = async () => (await stack.repo.listPendingOverrides([bob.userName])).map((o) => o.id);
  return { ...stack, eng: (await stack.repo.getStandupById(eng.id))!, platform, hooks, off, cards, pendingIds };
}

async function server() {
  const w = await world();
  const router = new EventRouter(w.commands, w.service, w.blockers, w.repo, TENANT, w.polls, async () => null, w.schedule);
  const app = createServer({
    router, scheduler: w.scheduler, adapter: w.adapter, blockers: w.blockers, repo: w.repo, settings: w.settings,
    dashboardToken: OPERATOR, skipVerification: true, secretKey: SECRET, service: w.service, schedule: w.schedule, now: w.clock.now,
  });
  const srv = app.listen(0);
  close = () => srv.close();
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/v1`;
  const cookieFor = (sub: string, name = sub) => `asyncup_sess=${sealSession(SECRET, newSession({ sub, email: `${sub}@o.com`, name, admin: false }))}`;
  const op = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' } });
  const as = (sub: string, path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: { cookie: cookieFor(sub), ...CSRF } });
  const patch = (who: string, body: unknown) => op(`/standups/${w.eng.id}/participants/${encodeURIComponent(who)}`, { method: 'PATCH', body: JSON.stringify(body) });
  return { ...w, router, op, as, patch };
}

describe('setting a reporting manager', () => {
  it('saves a pick from the People table and shows it on the row (criterion 1)', async () => {
    const { patch, op, eng } = await server();
    expect(await (await patch('users/bob', { reportingManager: neha.userName })).json()).toEqual({
      userName: 'users/bob', displayName: 'Bob', mandatory: true, onVacation: false, admin: false, reportingManager: 'users/neha', reportingManagerName: 'Neha',
    });
    const detail = (await (await op(`/standups/${eng.id}`)).json()) as any;
    expect(detail.participants.find((p: any) => p.userName === 'users/bob')).toMatchObject({ reportingManager: 'users/neha', reportingManagerName: 'Neha' });
  });

  it('offers only people who manage an active standup, and refuses anyone else (criterion 2)', async () => {
    const { patch, op, as, repo, eng, platform } = await server();
    const archived = await repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/old', name: 'Old', timezone: TZ });
    await repo.addAdmin(archived.id, 'users/zed', 'Zed');
    await repo.updateStandup(archived.id, { active: false });
    await repo.addAdmin(platform.id, 'users/admin', 'Admin'); // managing two standups lists them once
    expect(await (await op(`/standups/${eng.id}/manager-candidates`)).json()).toEqual({ managers: [{ userName: 'users/admin', displayName: 'Admin' }, neha] });
    expect((await as('bob', `/standups/${eng.id}/manager-candidates`)).status).toBe(403);
    for (const pick of ['users/carol', 'users/zed', 7]) {
      const res = await patch('users/bob', { reportingManager: pick, mandatory: false });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toEqual({ code: 'invalid', message: 'A reporting manager must already be a manager on a standup.', field: 'reportingManager' });
    }
    // A refused pick changes nothing else in the same request.
    expect((await repo.listParticipants(eng.id)).find((p) => p.userName === 'users/bob')).toMatchObject({ mandatory: true, reportingManager: null });
  });

  it('refuses someone reporting to themselves (criterion 3)', async () => {
    const { patch, repo, eng } = await server();
    await repo.upsertParticipant({ standupId: eng.id, userName: neha.userName, displayName: neha.displayName });
    expect(((await (await patch('users/neha', { reportingManager: 'users/neha' })).json()) as any).error).toEqual({ code: 'invalid', message: "Someone can't report to themselves.", field: 'reportingManager' });
  });

  it('clears it with None (criterion 4)', async () => {
    const { patch } = await server();
    await patch('users/bob', { reportingManager: neha.userName });
    expect(await (await patch('users/bob', { reportingManager: null })).json()).toMatchObject({ reportingManager: null, reportingManagerName: null });
  });

  it('is kept per standup (criterion 5)', async () => {
    const { repo, eng, platform } = await world();
    await repo.upsertParticipant({ standupId: platform.id, ...bob });
    await repo.setReportingManager(eng.id, bob.userName, neha);
    await repo.setReportingManager(platform.id, bob.userName, { userName: 'users/admin', displayName: 'Admin' });
    expect((await repo.listParticipants(eng.id)).find((p) => p.userName === 'users/bob')!.reportingManager).toBe('users/neha');
    expect((await repo.listParticipants(platform.id)).find((p) => p.userName === 'users/bob')!.reportingManager).toBe('users/admin');
  });

  it('starts someone added back by hand with none, but keeps it through a group sync (criterion 6)', async () => {
    const { op, repo, eng } = await server();
    const bobRow = async () => (await repo.listParticipants(eng.id)).find((p) => p.userName === 'users/bob')!;
    await repo.setReportingManager(eng.id, bob.userName, neha);
    await repo.upsertParticipant({ standupId: eng.id, ...bob }); // already on: unchanged
    expect((await bobRow()).reportingManager).toBe('users/neha');
    await repo.removeParticipant(eng.id, bob.userName);
    await op(`/standups/${eng.id}/participants`, { method: 'POST', body: JSON.stringify({ userName: 'users/bob', displayName: 'Bob' }) });
    expect(await bobRow()).toMatchObject({ reportingManager: null, reportingManagerName: null });

    await repo.setReportingManager(eng.id, bob.userName, neha);
    await repo.dropGroupMember(eng.id, bob.userName); // a manual row stays
    await repo.syncGroupMember(eng.id, bob.userName, 'Bob');
    expect((await bobRow()).reportingManager).toBe('users/neha');
  });
});

describe('requests and decisions', () => {
  it('sends the card to the managers and the reporting manager, once each (criterion 7)', async () => {
    const { repo, eng, off, cards } = await world();
    await repo.setReportingManager(eng.id, bob.userName, neha);
    await off(['2026-06-11']);
    expect(cards('users/admin')).toHaveLength(1);
    expect(cards('users/neha')).toHaveLength(1);
    expect(cards('users/neha')[0]!.request).toMatchObject({ person: bob, dates: ['2026-06-11'], working: false, standup: { id: eng.id } });

    await repo.setReportingManager(eng.id, bob.userName, { userName: 'users/admin', displayName: 'Admin' });
    await off(['2026-06-12']);
    expect(cards('users/admin')).toHaveLength(2);
  });

  it('still asks the managers when the reporting manager cannot be reached (criterion 7)', async () => {
    const { repo, eng, adapter, off, pendingIds } = await world();
    await repo.setReportingManager(eng.id, bob.userName, neha);
    const send = adapter.sendTimeOffRequest.bind(adapter);
    adapter.sendTimeOffRequest = async (to, request) => {
      if (to === neha.userName) throw new Error('cannot DM');
      return send(to, request);
    };
    expect(await off(['2026-06-11'])).toMatchObject({ ok: true, status: 'pending' });
    expect(await pendingIds()).toHaveLength(1);
  });

  it('names the reporting manager in the reply, unless there is none or they manage the standup (criterion 8)', async () => {
    const { repo, eng, off } = await world();
    expect((await off(['2026-06-11'])).message).toBe("📨 Sent to the managers of Daily Standup for approval — you'll hear back here. Withdraw with `off cancel 2026-06-11`.");
    await repo.setReportingManager(eng.id, bob.userName, neha);
    expect((await off(['2026-06-12'])).message).toBe("📨 Sent to Neha and the managers of Daily Standup for approval — you'll hear back here. Withdraw with `off cancel 2026-06-12`.");
    await repo.setReportingManager(eng.id, bob.userName, { userName: 'users/admin', displayName: 'Admin' });
    expect((await off(['2026-06-15'])).message).toStartWith('📨 Sent to the managers of Daily Standup');
    await repo.setReportingManager(eng.id, bob.userName, bob); // not possible through the API
    expect((await off(['2026-06-16'])).message).toStartWith('📨 Sent to the managers of Daily Standup');
  });

  it('leaves the reporting manager out of a working request (criterion 9)', async () => {
    const { repo, schedule, eng, off, cards, pendingIds } = await world();
    await repo.setReportingManager(eng.id, bob.userName, neha);
    expect(await off(['2026-06-13'], true)).toMatchObject({ ok: true, status: 'pending' });
    expect(cards('users/neha')).toHaveLength(0);
    expect(await schedule.decide(await pendingIds(), true, asSelf(neha), null)).toEqual({ ok: false, message: "Only Bob's managers can decide this." });
  });

  it('lets a reporting manager decide only while they report to them on an approval standup and still manage one (criterion 10)', async () => {
    const { repo, schedule, eng, platform, off, pendingIds } = await world();
    const decide = async () => schedule.decide(await pendingIds(), false, asSelf(neha), null);
    await off(['2026-06-11']);
    expect(await decide()).toEqual({ ok: false, message: "Only Bob's managers can decide this." });

    await repo.setReportingManager(eng.id, bob.userName, neha);
    await repo.removeAdmin(platform.id, neha.userName);
    expect(await decide()).toEqual({ ok: false, message: "Only Bob's managers can decide this." });
    await repo.addAdmin(platform.id, neha.userName, neha.displayName);
    await repo.updateStandup(platform.id, { active: false });
    expect(await decide()).toEqual({ ok: false, message: "Only Bob's managers can decide this." });
    await repo.updateStandup(platform.id, { active: true });
    expect(await decide()).toEqual({ ok: true, status: 'active', message: '❌ Declined — Bob has been told.' });
  });

  it('decides from the Chat card and through the API alike (criterion 10)', async () => {
    const { repo, router, as, eng, platform, off, pendingIds } = await server();
    await repo.setReportingManager(eng.id, bob.userName, neha);
    const click = async () => (await router.handle({
      type: 'CARD_CLICKED',
      common: { invokedFunction: APPROVE_REQUEST_FN, parameters: { requestIds: (await pendingIds()).join(',') } },
      user: { name: neha.userName, displayName: neha.displayName, type: 'HUMAN' },
      space: { name: 'spaces/dm-neha', spaceType: 'DIRECT_MESSAGE' },
    })) as any;
    await off(['2026-06-11']);
    expect((await click()).text).toBe('✅ Approved — Bob has been told.');

    await off(['2026-06-12']);
    expect((await as('neha', `/requests/${(await pendingIds()).join(',')}/approve`, { method: 'POST', body: '{}' })).status).toBe(200);
    await off(['2026-06-15']);
    await repo.removeAdmin(platform.id, neha.userName);
    expect((await click()).text).toBe("Only Bob's managers can decide this.");
    expect((await as('neha', `/requests/${(await pendingIds()).join(',')}/approve`, { method: 'POST', body: '{}' })).status).toBe(403);
  });

  it('gives a reporting manager nothing on a self or managers standup (criterion 11)', async () => {
    const { repo, schedule, eng, off, cards, pendingIds } = await world();
    const design = await repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/design', name: 'Design', timezone: TZ });
    await repo.upsertParticipant({ standupId: design.id, ...bob }); // Design is self, and Neha doesn't manage it
    await repo.setReportingManager(design.id, bob.userName, neha);
    await off(['2026-06-11']);
    expect(cards('users/neha')).toHaveLength(0);
    expect(await schedule.decide(await pendingIds(), true, asSelf(neha), null)).toEqual({ ok: false, message: "Only Bob's managers can decide this." });

    await repo.updateStandup(design.id, { timeOffPolicy: 'managers' });
    expect(await off(['2026-06-12'])).toMatchObject({ ok: false });
    expect(await repo.listReportsOf(TENANT, neha.userName)).toEqual([]);
    await repo.setReportingManager(eng.id, bob.userName, neha);
    expect(await repo.listReportsOf(TENANT, neha.userName)).toEqual(['users/bob']);
  });

  it('applies a reporting manager’s approval as a manager’s would (criterion 12)', async () => {
    const { repo, schedule, scheduler, settings, leave, leaveWriter, adapter, eng, off, pendingIds, hooks } = await world();
    await settings.update({ leaveInChat: true });
    await repo.setUserEmail(bob.userName, 'bob@example.com');
    await scheduler.tick();
    const run = (await repo.getRun(eng.id, '2026-06-10'))!;
    await repo.setReportingManager(eng.id, bob.userName, neha);
    await off(['2026-06-10']);
    const ids = await pendingIds();
    expect(await schedule.decide(ids, true, asSelf(neha), null)).toEqual({ ok: true, status: 'active', message: '✅ Approved — Bob has been told. Their Chat status and calendar will show it.' });
    expect(await schedule.decide(ids, false, { userName: 'users/admin', displayName: 'Admin', admin: false }, null)).toEqual({ ok: false, message: 'That request was already decided or withdrawn.' });
    expect((await repo.getOverride(bob.userName, '2026-06-10'))!).toMatchObject({ status: 'active', decidedByDisplayName: 'Neha' });
    expect((await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/bob')).toMatchObject({ awayReason: 'day_off' });
    expect(adapter.dms.at(-1)).toMatchObject({ userName: 'users/bob', text: expect.stringContaining('Neha approved your time off request for Wed 10 Jun.') });
    expect(hooks.at(-1)).toMatchObject({ event: 'schedule_change', summary: 'approved: off Wed 10 Jun', by: 'Neha' });
    await leave.sweep();
    expect(leaveWriter.calls).toEqual(['create bob@example.com', 'status bob@example.com On leave until Wed 10 Jun']);
  });

  it('shows a reporting manager their reports’ days off in Team › Requests, not their working requests (criterion 13)', async () => {
    const { repo, schedule, as, eng, platform, off } = await server();
    const dev = { userName: 'users/dev', displayName: 'Dev' };
    await repo.upsertParticipant({ standupId: platform.id, ...dev });
    await repo.updateStandup(platform.id, { timeOffPolicy: 'approval' });
    await schedule.setOverride({ target: dev, dates: ['2026-06-19'], working: true, reason: '', actor: asSelf(dev), channel: 'chat' }); // Neha manages Dev
    await schedule.setOverride({ target: dev, dates: ['2026-06-12'], working: false, reason: '', actor: asSelf(dev), channel: 'chat' });
    await repo.setReportingManager(eng.id, bob.userName, neha);
    await off(['2026-06-11']);
    await off(['2026-06-13'], true);
    const seen = (await (await as('neha', '/requests')).json()) as any;
    expect(seen.requests.map((r: any) => [r.displayName, r.date, r.working])).toEqual([['Bob', '2026-06-11', false], ['Dev', '2026-06-12', false], ['Dev', '2026-06-19', true]]);
    expect(((await (await as('admin', '/requests')).json()) as any).requests).toHaveLength(2); // Bob's both, as his manager
    expect((await as('carol', '/requests')).status).toBe(403);
  });

  it('still sends a reporting manager’s own request to their managers (criterion 14)', async () => {
    const { repo, schedule, eng } = await world();
    await repo.upsertParticipant({ standupId: eng.id, ...neha });
    await schedule.setOverride({ target: neha, dates: ['2026-06-11'], working: false, reason: '', actor: asSelf(neha), channel: 'chat' });
    const ids = (await repo.listPendingOverrides([neha.userName])).map((o) => o.id);
    expect(await schedule.decide(ids, true, asSelf(neha), null)).toEqual({ ok: false, message: 'Your own requests go to your managers.' });
  });
});
