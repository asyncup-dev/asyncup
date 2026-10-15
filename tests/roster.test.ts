import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { GroupAccessError } from '../src/core/groups.js';
import { RosterSync } from '../src/core/roster-sync.js';
import { GoogleGroupDirectory } from '../src/integrations/google-groups.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const GROUP = 'devs@example.com';
const asha = { userName: 'users/1', displayName: 'Asha', email: 'asha@example.com' };
const ravi = { userName: 'users/2', displayName: 'Ravi', email: 'ravi@example.com' };
const meera = { userName: 'users/3', displayName: 'Meera', email: 'meera@example.com' };

async function groupStandup() {
  const stack = await makeStack();
  const created = await stack.repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/devs', name: 'Devs', timezone: 'Asia/Kolkata' });
  await stack.repo.updateStandup(created.id, { rosterGroup: GROUP });
  stack.groups.listings.set(GROUP, { members: [asha, ravi], skipped: [{ email: 'guest@other.com', reason: 'outside your Workspace' }] });
  const standup = async () => (await stack.repo.getStandupById(created.id))!;
  return { ...stack, standup };
}

describe('RosterSync', () => {
  it('fills the roster from the group with the default setup, and reports who was skipped', async () => {
    const { roster, repo, standup, clock } = await groupStandup();
    clock.set('2026-06-10T08:00');
    const result = await roster.sync(await standup());
    expect(result).toEqual({ ok: true, added: ['Asha', 'Ravi'], removed: [], skipped: [{ email: 'guest@other.com', reason: 'outside your Workspace' }] });
    const people = await repo.listParticipants((await standup()).id);
    expect(people.map((p) => [p.userName, p.mandatory, p.workingDays, p.source])).toEqual([
      ['users/1', true, null, 'group'],
      ['users/2', true, null, 'group'],
    ]);
    expect(await standup()).toMatchObject({ rosterSyncedAt: '2026-06-10T02:30:00.000Z', rosterSyncError: null });
  });

  it('takes a leaver out of the open run too', async () => {
    const { roster, repo, standup, groups } = await groupStandup();
    await roster.sync(await standup());
    const run = await repo.createRun((await standup()).id, '2026-06-10', 'k');
    groups.listings.set(GROUP, { members: [ravi], skipped: [] });
    expect(await roster.sync(await standup())).toMatchObject({ removed: ['Asha'] });
    expect((await repo.listRunParticipants(run.id)).map((p) => p.displayName)).toEqual(['Ravi']);
  });

  it('follows joiners, leavers and renames, and keeps hand-made changes', async () => {
    const { roster, repo, standup, groups } = await groupStandup();
    const id = (await standup()).id;
    await roster.sync(await standup());
    await repo.upsertParticipant({ standupId: id, userName: 'users/9', displayName: 'Contractor' }); // added by hand
    await repo.excludeParticipant(id, 'users/2'); // Ravi taken off by hand
    groups.listings.set(GROUP, { members: [{ ...asha, displayName: 'Asha K' }, ravi, meera], skipped: [] });
    expect(await roster.sync(await standup())).toMatchObject({ added: ['Meera'], removed: [] });
    expect((await repo.listParticipants(id)).map((p) => p.displayName)).toEqual(['Asha K', 'Contractor', 'Meera']);

    // Asha leaves the group; the hand-added contractor stays
    groups.listings.set(GROUP, { members: [ravi, meera], skipped: [] });
    expect(await roster.sync(await standup())).toMatchObject({ added: [], removed: ['Asha K'] });
    expect((await repo.listParticipants(id)).map((p) => p.displayName)).toEqual(['Contractor', 'Meera']);
    // and comes back
    groups.listings.set(GROUP, { members: [asha, ravi, meera], skipped: [] });
    expect(await roster.sync(await standup())).toMatchObject({ added: ['Asha'] });
    // adding Ravi back by hand clears the keep-off
    await repo.upsertParticipant({ standupId: id, userName: 'users/2', displayName: 'Ravi' });
    expect((await repo.listRosterRows(id)).find((r) => r.userName === 'users/2')).toMatchObject({ active: true, keptOff: false });
  });

  it('records why a sync failed and leaves the roster alone', async () => {
    const { roster, repo, standup, groups } = await groupStandup();
    await roster.sync(await standup());
    groups.listings.set(GROUP, new GroupAccessError('AsyncUp can’t read devs@example.com.'));
    expect(await roster.sync(await standup())).toEqual({ ok: false, message: 'AsyncUp can’t read devs@example.com.' });
    expect((await standup()).rosterSyncError).toBe('AsyncUp can’t read devs@example.com.');
    groups.listings.set(GROUP, new Error('socket hang up'));
    expect(await roster.sync(await standup())).toEqual({ ok: false, message: 'Google did not answer: socket hang up' });
    expect((await repo.listParticipants((await standup()).id))).toHaveLength(2);

    const logs: string[] = [];
    const offline = new RosterSync(repo, async () => null, undefined, (m) => logs.push(m));
    expect(await offline.sync(await standup())).toEqual({ ok: false, message: 'Reading Google Groups needs the service-account key under Settings › Google Chat.' });
    expect(logs).toEqual(['roster sync for "Devs" failed: Reading Google Groups needs the service-account key under Settings › Google Chat.']);
    const plain = await seedStandup(repo, { spaceName: 'spaces/plain' });
    expect(await offline.sync(plain)).toMatchObject({ ok: false, message: 'Google Chat is not connected, so the space can’t be checked.' });
    expect(offline.stale(plain, 10)).toBe(false);
  });

  it('reports a thrown non-error as Google not answering', async () => {
    const { repo, standup } = await groupStandup();
    const odd = new RosterSync(repo, async () => ({ listMembers: async () => { throw 'boom'; } }));
    expect(await odd.sync(await standup())).toEqual({ ok: false, message: 'Google did not answer: boom' });
  });
});

describe('roster sync in the scheduler', () => {
  it('syncs hourly, again in the hour before the run, and before run-now', async () => {
    const { scheduler, groups, clock, standup, repo } = await groupStandup();
    clock.set('2026-06-10T06:00'); // Wednesday, prompt at 09:30
    await scheduler.tick();
    expect(groups.calls).toHaveLength(1);
    clock.set('2026-06-10T06:30');
    await scheduler.tick();
    expect(groups.calls).toHaveLength(1); // fresh within the hour
    clock.set('2026-06-10T08:45');
    await scheduler.tick(); // stale, and within the hour before the prompt: one sync per tick
    expect(groups.calls).toHaveLength(2);
    clock.set('2026-06-10T09:00');
    await scheduler.tick(); // ten minutes is enough before the run
    expect(groups.calls).toHaveLength(3);
    // the synced roster is what the run opens with
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const run = (await repo.getRun((await standup()).id, '2026-06-10'))!;
    expect((await repo.listRunParticipants(run.id)).map((p) => p.userName)).toEqual(['users/1', 'users/2']);

    const second = await repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/more', name: 'More', timezone: 'Asia/Kolkata' });
    await repo.updateStandup(second.id, { rosterGroup: GROUP });
    const before = groups.calls.length;
    expect(await scheduler.runNow((await repo.getStandupById(second.id))!)).toBe('started');
    expect(groups.calls.length).toBe(before + 1);
  });
});

/** Stub the Google client: answers in order, recording each request. */
function stubGoogle(answers: ((opts: any) => unknown)[]) {
  const calls: { url: string; params: any; subject?: string; scopes: unknown }[] = [];
  const spy = spyOn(OAuth2Client.prototype, 'request').mockImplementation(async function (this: JWT, opts: any) {
    calls.push({ url: opts.url, params: opts.params, subject: this.subject, scopes: this.scopes });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected request ${opts.url}`);
    return answer(opts) as any;
  });
  return { calls, restore: () => spy.mockRestore() };
}
const httpError = (status: number) => () => {
  throw Object.assign(new Error(`HTTP ${status}`), { response: { status } });
};
const CREDS = JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: 'PEM' });

describe('GoogleGroupDirectory', () => {
  it('lists people across pages as the service account itself, skipping who cannot be on a standup', async () => {
    const g = stubGoogle([
      () => ({ data: { members: [
        { id: '1', email: 'asha@example.com', type: 'USER', status: 'ACTIVE' },
        { id: 'g1', email: 'nested@example.com', type: 'GROUP' },
        { id: '5', email: 'guest@other.com', type: 'EXTERNAL' },
      ], nextPageToken: 'p2' } }),
      () => ({ data: { members: [
        { id: '1', email: 'asha@example.com', type: 'USER', status: 'ACTIVE' },
        { id: '2', email: 'ravi@example.com', type: 'USER' },
        { id: '3', email: 'gone@example.com', type: 'USER', status: 'ACTIVE' },
        { id: '4', email: 'away@example.com', type: 'USER', status: 'ACTIVE' },
        { id: '6', email: 'new@example.com', type: 'USER', status: 'PENDING' },
      ] } }),
      () => ({ data: { name: { fullName: 'Asha Rao' } } }),
      () => ({ data: {} }),
      httpError(404),
      () => ({ data: { name: { fullName: 'Away' }, suspended: true } }),
    ]);
    try {
      const listing = await new GoogleGroupDirectory(CREDS).listMembers('devs@example.com');
      expect(listing.members).toEqual([
        { userName: 'users/1', displayName: 'Asha Rao', email: 'asha@example.com' },
        { userName: 'users/2', displayName: 'ravi@example.com', email: 'ravi@example.com' },
      ]);
      expect(listing.skipped).toEqual([
        { email: 'guest@other.com', reason: 'outside your Workspace' },
        { email: 'gone@example.com', reason: 'no longer in the directory' },
        { email: 'away@example.com', reason: 'suspended' },
        { email: 'new@example.com', reason: 'not active' },
      ]);
      expect(g.calls[0]).toMatchObject({ url: 'https://admin.googleapis.com/admin/directory/v1/groups/devs%40example.com/members', params: { includeDerivedMembership: true, maxResults: 200 }, subject: undefined });
      expect(g.calls[1]!.params.pageToken).toBe('p2');
      expect(g.calls[2]).toMatchObject({ url: 'https://admin.googleapis.com/admin/directory/v1/users/1', params: { fields: 'name/fullName,suspended' } });
      expect(g.calls[0]!.scopes).toEqual(['https://www.googleapis.com/auth/admin.directory.group.readonly', 'https://www.googleapis.com/auth/admin.directory.user.readonly']);
    } finally {
      g.restore();
    }
  });

  it('explains a missing group or a missing role, and passes other failures on', async () => {
    const dir = new GoogleGroupDirectory(CREDS);
    let g = stubGoogle([httpError(404)]);
    await expect(dir.listMembers('nope@example.com')).rejects.toThrow('There is no Google Group nope@example.com.');
    g.restore();
    g = stubGoogle([httpError(403)]);
    await expect(dir.listMembers('devs@example.com')).rejects.toThrow(/give bot@proj\.iam\.gserviceaccount\.com an admin role with Groups › Read and Users › Read/);
    g.restore();
    g = stubGoogle([() => ({ data: { members: [{ id: '1', email: 'a@example.com', type: 'USER' }] } }), httpError(403)]);
    await expect(dir.listMembers('devs@example.com')).rejects.toBeInstanceOf(GroupAccessError);
    g.restore();
    g = stubGoogle([() => { throw Object.assign(new Error('quota'), { code: 429 }); }]);
    await expect(dir.listMembers('devs@example.com')).rejects.toThrow('quota');
    g.restore();
    g = stubGoogle([() => ({ data: {} })]);
    expect(await dir.listMembers('empty@example.com')).toEqual({ members: [], skipped: [] });
    g.restore();
  });
});

describe('roster API', () => {
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
  });

  async function startServer(withRoster = true) {
    const stack = await groupStandup();
    const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
    const app = createServer({
      router,
      scheduler: stack.scheduler,
      adapter: stack.adapter,
      blockers: stack.blockers,
      repo: stack.repo,
      settings: stack.settings,
      dashboardToken: 'op',
      skipVerification: true,
      secretKey: 'k',
      service: stack.service,
      ...(withRoster ? { roster: stack.roster } : {}),
      now: stack.clock.now,
    });
    const server = app.listen(0);
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    const op = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: { authorization: 'Bearer op', 'content-type': 'application/json' } });
    return { ...stack, op, id: (await stack.standup()).id };
  }

  it('syncs on demand, takes people off for good, and shows the roster state', async () => {
    const { op, id, groups, repo } = await startServer();
    let res = await op(`/standups/${id}/roster/sync`, { method: 'POST' });
    expect(await res.json()).toMatchObject({ added: ['Asha', 'Ravi'], removed: [], skipped: [{ email: 'guest@other.com' }] });
    expect((await op(`/standups/${id}/participants/${encodeURIComponent('users/2')}`, { method: 'DELETE' })).status).toBe(204);
    expect((await op(`/standups/${id}/participants/${encodeURIComponent('users/zed')}`, { method: 'DELETE' })).status).toBe(404);
    await op(`/standups/${id}/roster/sync`, { method: 'POST' });
    const detail = (await (await op(`/standups/${id}`)).json()) as any;
    expect(detail.participants.map((p: any) => [p.userName, p.source])).toEqual([['users/1', 'group']]);
    expect(detail.keptOff).toEqual([{ userName: 'users/2', displayName: 'Ravi' }]);
    expect(detail.roster).toMatchObject({ group: GROUP, error: null });

    groups.listings.set(GROUP, new GroupAccessError('AsyncUp can’t read devs@example.com.'));
    res = await op(`/standups/${id}/roster/sync`, { method: 'POST' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'roster_unavailable', message: 'AsyncUp can’t read devs@example.com.' } });
    expect(((await (await op('/standups')).json()) as any).standups[0].roster.error).toBe('AsyncUp can’t read devs@example.com.');

    // without a group the space is checked instead, never 409 (spec 002, criterion 16)
    await repo.updateStandup(id, { rosterGroup: null });
    res = await op(`/standups/${id}/roster/sync`, { method: 'POST' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.message).toBe('The space listed no members, so nobody was taken off.');
  });

  it('syncs as soon as a group is set, and validates it', async () => {
    const { op, id, repo } = await startServer();
    await repo.updateStandup(id, { rosterGroup: null });
    let res = await op(`/standups/${id}`, { method: 'PATCH', body: JSON.stringify({ rosterGroup: 'not an email' }) });
    expect(((await res.json()) as any).error.field).toBe('rosterGroup');
    res = await op(`/standups/${id}`, { method: 'PATCH', body: JSON.stringify({ rosterGroup: ' Devs@Example.com ' }) });
    expect(((await res.json()) as any).roster.group).toBe(GROUP);
    expect((await repo.listParticipants(id)).map((p) => p.displayName)).toEqual(['Asha', 'Ravi']);
    res = await op(`/standups/${id}`, { method: 'PATCH', body: JSON.stringify({ rosterGroup: null }) });
    expect(((await res.json()) as any).roster.group).toBeNull();
    // taking someone off a hand-made roster just removes them
    expect((await op(`/standups/${id}/participants/${encodeURIComponent('users/1')}`, { method: 'DELETE' })).status).toBe(204);
    expect((await repo.listRosterRows(id)).find((r) => r.userName === 'users/1')).toMatchObject({ active: false, keptOff: false });
  });

  it('creates a standup straight from a group, and answers 503 without roster support', async () => {
    const { op } = await startServer();
    const res = await op('/standups', { method: 'POST', body: JSON.stringify({ name: 'Group daily', spaceName: 'spaces/new', rosterGroup: GROUP, runNow: true }) });
    expect(res.status).toBe(201);
    const created = (await res.json()) as any;
    expect(created.participants.map((p: any) => p.displayName)).toEqual(['Asha', 'Ravi']);
    expect(created.runNow).toBe('started');

    close?.();
    const bare = await startServer(false);
    expect((await bare.op(`/standups/${bare.id}/roster/sync`, { method: 'POST' })).status).toBe(503);
  });
});
