import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { GroupAccessError } from '../src/core/groups.js';
import { RosterSync } from '../src/core/roster-sync.js';
import { createServer } from '../src/server.js';
import { ANSWERS, makeStack, seedStandup, TENANT } from './helpers.js';

const SPACE = 'spaces/team';
const alice = { userName: 'users/alice', displayName: 'Alice' };
const bob = { userName: 'users/bob', displayName: 'Bob' };
const carol = { userName: 'users/carol', displayName: 'Carol' };

/** A hand-picked roster (Alice, Bob, Carol) on a space everyone is in. */
async function spaceStandup() {
  const stack = await makeStack();
  const created = await seedStandup(stack.repo);
  stack.adapter.members.set(SPACE, [alice, bob, carol]);
  const standup = async () => (await stack.repo.getStandupById(created.id))!;
  const names = async () => (await stack.repo.listParticipants(created.id)).map((p) => p.displayName);
  return { ...stack, standup, names, id: created.id };
}

describe('space membership sync', () => {
  it('marks who is in the space, then takes off people who leave it, keeping their history (criteria 2, 3)', async () => {
    const { roster: sync, repo, adapter, standup, names, id, clock } = await spaceStandup();
    clock.set('2026-06-10T08:00');
    expect(await sync.sync(await standup())).toEqual({ ok: true, added: [], removed: [], skipped: [] });
    expect((await repo.listRosterRows(id)).map((r) => [r.userName, r.inSpace])).toEqual([
      ['users/alice', true],
      ['users/bob', true],
      ['users/carol', true],
    ]);
    expect(await standup()).toMatchObject({ rosterSyncedAt: '2026-06-10T02:30:00.000Z', rosterSyncError: null });

    adapter.members.set(SPACE, [alice, carol]);
    expect(await sync.sync(await standup())).toMatchObject({ ok: true, added: [], removed: ['Bob'] });
    expect(await names()).toEqual(['Alice', 'Carol']);
    expect((await repo.listRosterRows(id)).find((r) => r.userName === 'users/bob')).toMatchObject({ active: false, leftSpaceAt: '2026-06-10T02:30:00.000Z' });
  });

  it('never takes off someone who was never seen in the space (criterion 4)', async () => {
    const { roster: sync, repo, adapter, standup, names, id } = await spaceStandup();
    await repo.upsertParticipant({ standupId: id, userName: 'users/dan', displayName: 'Dan' }); // added through the API from outside the space
    adapter.members.set(SPACE, [alice, bob, carol]);
    await sync.sync(await standup());
    await sync.sync(await standup());
    expect(await names()).toEqual(['Alice', 'Bob', 'Carol', 'Dan']);
  });

  it('takes a leaver out of the open run unless they answered (criterion 5)', async () => {
    const { roster: sync, repo, adapter, standup, service, scheduler, clock, id } = await spaceStandup();
    clock.set('2026-06-10T09:31');
    await scheduler.tick();
    const run = (await repo.getRun(id, '2026-06-10'))!;
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    adapter.members.set(SPACE, [carol]);
    expect(await sync.sync(await standup())).toMatchObject({ removed: ['Alice', 'Bob'] });
    expect((await repo.listRunParticipants(run.id)).map((p) => p.displayName)).toEqual(['Alice', 'Carol']);
    expect(await repo.getSubmission(run.id, 'users/alice')).not.toBeNull();
  });

  it('puts back someone who rejoins with their old settings, but not someone removed by hand (criteria 6, 7)', async () => {
    const { roster: sync, repo, adapter, standup, names, id } = await spaceStandup();
    await sync.sync(await standup());
    adapter.members.set(SPACE, [alice]);
    await sync.sync(await standup());
    expect(await names()).toEqual(['Alice']);
    await repo.removeParticipant(id, 'users/bob'); // a manager takes Bob off by hand after he left

    adapter.members.set(SPACE, [alice, bob, carol]);
    expect(await sync.sync(await standup())).toMatchObject({ ok: true, added: ['Carol'], removed: [] });
    expect(await names()).toEqual(['Alice', 'Carol']);
    expect((await repo.listParticipants(id)).find((p) => p.userName === 'users/carol')).toMatchObject({ mandatory: false });
    expect((await repo.listRosterRows(id)).find((r) => r.userName === 'users/carol')).toMatchObject({ leftSpaceAt: null });

    // added again by hand, Bob is back and followed from then on
    await repo.upsertParticipant({ standupId: id, userName: 'users/bob', displayName: 'Bob' });
    adapter.members.set(SPACE, [alice, carol]);
    expect(await sync.sync(await standup())).toMatchObject({ removed: ['Bob'] });
  });

  it('leaves group rosters to the group (criterion 8)', async () => {
    const { roster: sync, repo, adapter, groups, standup, names, id } = await spaceStandup();
    await sync.sync(await standup());
    await repo.updateStandup(id, { rosterGroup: 'devs@example.com' });
    groups.listings.set('devs@example.com', { members: [{ ...alice, email: 'a@example.com' }], skipped: [] });
    adapter.members.set(SPACE, []);
    expect(await sync.sync(await standup())).toMatchObject({ ok: true, added: [], removed: [] });
    expect(await names()).toEqual(['Alice', 'Bob', 'Carol']); // hand-added Bob and Carol stay, as today
  });
});

describe('Google Groups in the space', () => {
  it('counts a group’s members as in the space (criterion 9)', async () => {
    const { roster: sync, adapter, groups, standup, names } = await spaceStandup();
    await sync.sync(await standup());
    adapter.members.set(SPACE, [alice]);
    adapter.spaceGroups.set(SPACE, ['groups/03x8tuzt1ue3hl6']);
    groups.listings.set('03x8tuzt1ue3hl6', { members: [{ ...bob, email: 'b@example.com' }], skipped: [] });
    expect(await sync.sync(await standup())).toMatchObject({ ok: true, removed: ['Carol'] });
    expect(await names()).toEqual(['Alice', 'Bob']);
    expect(groups.calls).toEqual(['03x8tuzt1ue3hl6']);
  });

  it('takes nobody off when a group can’t be read, still puts people back, and says why (criterion 10)', async () => {
    const { roster: sync, repo, adapter, groups, standup, names, id } = await spaceStandup();
    await sync.sync(await standup());
    adapter.members.set(SPACE, [alice, bob]);
    await sync.sync(await standup()); // Carol leaves
    adapter.members.set(SPACE, [carol]); // Carol rejoins; Alice and Bob are only in the group now
    adapter.spaceGroups.set(SPACE, ['groups/g1']);
    groups.listings.set('g1', new GroupAccessError('AsyncUp can’t read g1.'));
    const result = await sync.sync(await standup());
    expect(result).toEqual({ ok: false, message: 'A Google Group in this space can’t be read (groups/g1), so nobody was taken off. AsyncUp can’t read g1.' });
    expect(await names()).toEqual(['Alice', 'Bob', 'Carol']);
    expect((await standup()).rosterSyncError).toBe(result.ok ? null : result.message);

    groups.listings.set('g1', new Error('quota'));
    expect(await sync.sync(await standup())).toMatchObject({ message: expect.stringContaining('Google did not answer: quota') });
    const keyless = new RosterSync(repo, async () => null, undefined, () => {}, null, adapter);
    expect(await keyless.sync(await standup())).toMatchObject({ message: 'A Google Group in this space (groups/g1) can’t be read without the service-account key under Settings › Google Chat, so nobody was taken off.' });
    expect(await repo.listParticipants(id)).toHaveLength(3);
  });
});

describe('when the space can’t be checked', () => {
  it('changes nothing when Chat fails or the space lists nobody (criteria 11, 12)', async () => {
    const { roster: sync, adapter, standup, names } = await spaceStandup();
    await sync.sync(await standup());
    adapter.membershipError = new Error('The caller does not have permission');
    expect(await sync.sync(await standup())).toEqual({ ok: false, message: 'Google Chat did not answer, so nobody was taken off: The caller does not have permission' });
    adapter.membershipError = null;
    adapter.members.set(SPACE, []);
    expect(await sync.sync(await standup())).toEqual({ ok: false, message: 'The space listed no members, so nobody was taken off.' });
    expect(await names()).toEqual(['Alice', 'Bob', 'Carol']);
    expect((await standup()).rosterSyncError).toBe('The space listed no members, so nobody was taken off.');
  });

  it('reports a thrown non-error, and needs Chat to check at all', async () => {
    const { repo, standup } = await spaceStandup();
    const odd = new RosterSync(repo, async () => null, undefined, () => {}, null, { spaceMembership: async () => { throw 'boom'; } });
    expect(await odd.sync(await standup())).toMatchObject({ message: 'Google Chat did not answer, so nobody was taken off: boom' });
    const chatless = new RosterSync(repo, async () => null);
    expect(chatless.stale(await standup(), 10)).toBe(false);
    expect(await chatless.sync(await standup())).toEqual({ ok: false, message: 'Google Chat is not connected, so the space can’t be checked.' });
  });
});

describe('space sync in the scheduler', () => {
  it('checks the space hourly and again in the hour before the run (criterion 1)', async () => {
    const { scheduler, adapter, clock, standup } = await spaceStandup();
    let calls = 0;
    const list = adapter.spaceMembership.bind(adapter);
    adapter.spaceMembership = async (space: string) => (calls++, list(space));
    clock.set('2026-06-10T06:00'); // Wednesday, prompt at 09:30
    await scheduler.tick();
    expect(calls).toBe(1);
    clock.set('2026-06-10T06:30');
    await scheduler.tick();
    expect(calls).toBe(1);
    clock.set('2026-06-10T09:00');
    await scheduler.tick();
    expect(calls).toBe(2);
    expect((await standup()).rosterSyncedAt).not.toBeNull();
  });
});

describe('space sync through the API', () => {
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
  });

  it('syncs on demand and lists who left the space (criteria 14–17)', async () => {
    const stack = await spaceStandup();
    const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
    const app = createServer({ router, scheduler: stack.scheduler, adapter: stack.adapter, blockers: stack.blockers, repo: stack.repo, settings: stack.settings, dashboardToken: 'op', skipVerification: true, secretKey: 'k', service: stack.service, roster: stack.roster, now: stack.clock.now });
    const server = app.listen(0);
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    const op = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${url}${path}`, { ...init, headers: { authorization: 'Bearer op', 'content-type': 'application/json' } });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    };
    stack.clock.set('2026-06-10T08:00');

    expect((await op(`/standups/${stack.id}/roster/sync`, { method: 'POST' })).body).toEqual({ added: [], removed: [], skipped: [], syncedAt: '2026-06-10T02:30:00.000Z' });
    stack.adapter.members.set(SPACE, [alice, carol]);
    expect((await op(`/standups/${stack.id}/roster/sync`, { method: 'POST' })).body).toMatchObject({ removed: ['Bob'] });
    let detail = (await op(`/standups/${stack.id}`)).body;
    expect(detail.roster).toEqual({ group: null, syncedAt: '2026-06-10T02:30:00.000Z', error: null, leftSpace: [{ userName: 'users/bob', displayName: 'Bob', at: '2026-06-10T02:30:00.000Z' }] });

    stack.adapter.members.set(SPACE, []);
    const failed = await op(`/standups/${stack.id}/roster/sync`, { method: 'POST' });
    expect(failed).toEqual({ status: 502, body: { error: { code: 'roster_unavailable', message: 'The space listed no members, so nobody was taken off.' } } });

    // taking Bob off by hand ends his "left the space" entry
    expect((await op(`/standups/${stack.id}/participants/${encodeURIComponent('users/bob')}`, { method: 'DELETE' })).status).toBe(204);
    detail = (await op(`/standups/${stack.id}`)).body;
    expect(detail.roster.leftSpace).toEqual([]);
    expect((await op('/standups')).body.standups[0].roster).not.toHaveProperty('leftSpace');
  });
});
