import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT, withBlocker } from './helpers.js';

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

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
    dashboardToken: 'op',
    skipVerification: true,
    secretKey: 'k',
    service: stack.service,
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const del = (id: number, confirm: unknown, auth: Record<string, string> = { authorization: 'Bearer op' }) =>
    fetch(`${url}/standups/${id}`, { method: 'DELETE', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ confirm }) });
  const manager = { cookie: `asyncup_sess=${sealSession('k', newSession({ sub: 'bob', email: 'bob@o.com', name: 'Bob', admin: false }))}`, 'x-requested-with': 'asyncup' };
  return { ...stack, url, del, manager };
}

describe('deleting a standup', () => {
  it('needs a workspace admin, an archived standup and its name typed back, then removes everything it owns', async () => {
    const { repo, del, manager, clock, scheduler, service, blockers, polls, url } = await startServer();
    const standup = await seedStandup(repo);
    const other = await seedStandup(repo, { spaceName: 'spaces/other' });
    await repo.addAdmin(standup.id, 'users/bob', 'Bob');
    await repo.setWorkingDaysForUser('users/alice', 'mon,tue,wed');
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    await service.submit(run.id, 'users/alice', 'Alice', withBlocker('Waiting on API keys'));
    const blocker = (await repo.listOpenBlockers(standup.id))[0]!;
    await blockers.tag(standup, blocker.id, [{ userName: 'users/bob', displayName: 'Bob' }], { userName: 'users/alice', displayName: 'Alice' });
    await blockers.addUpdate(blocker.id, { userName: 'users/bob', displayName: 'Bob' }, 'on it');
    const poll = await polls.create(standup, 'Lunch?', ['Yes', 'No'], { userName: 'users/alice', displayName: 'Alice' });
    await polls.vote(poll.id, { userName: 'users/bob', displayName: 'Bob' }, 0);
    await repo.logScheduleChange({ userName: 'users/alice', displayName: 'Alice', summary: 'x', byDisplayName: 'Alice', channel: 'chat', at: '2026-06-10T00:00:00Z' });
    await repo.markChangesDigested(standup.id, [1], '2026-06-10T01:00:00Z');

    // a manager of the standup is not enough
    expect((await del(standup.id, standup.name, manager)).status).toBe(403);
    // a live standup must be archived first
    let res = await del(standup.id, standup.name);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe('active');
    await repo.updateStandup(standup.id, { active: false });
    res = await del(standup.id, 'daily standup');
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatchObject({ field: 'confirm', message: 'Send { "confirm": "Daily Standup" } to delete this standup and all its history.' });
    expect((await del(9999, 'x')).status).toBe(404);

    res = await del(standup.id, 'Daily Standup');
    expect(await res.json()).toEqual({ deleted: { runs: 1, submissions: 1, blockers: 1, polls: 1 } });
    expect((await fetch(`${url}/standups/${standup.id}`, { headers: { authorization: 'Bearer op' } })).status).toBe(404);
    expect(await repo.getStandupById(standup.id)).toBeNull();
    expect(await repo.listRunParticipants(run.id)).toEqual([]);
    expect(await repo.listParticipants(standup.id)).toEqual([]);
    expect(await repo.listAdmins(standup.id)).toEqual([]);
    expect(await repo.listUndigestedChanges(standup.id, ['users/alice'], '')).toHaveLength(1); // the digest record went with it

    // the other standup, and Alice's own week, are untouched
    expect((await repo.listParticipants(other.id)).map((p) => [p.userName, p.workingDays])).toContainEqual(['users/alice', 'mon,tue,wed']);
  });
});
