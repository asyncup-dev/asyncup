import { describe, expect, it } from 'vitest';
import { EventRouter } from '../src/adapters/gchat/events.js';
import type { Mention } from '../src/core/commands.js';
import { ANSWERS, makeStack, seedStandup, TENANT, withBlocker } from './helpers.js';

const ADMIN = { userName: 'users/admin', displayName: 'Admin' };
const ALICE = { userName: 'users/alice', displayName: 'Alice' };
const BOB = { userName: 'users/bob', displayName: 'Bob' };

function ctx(text: string, mentions: Mention[] = [], sender: Mention = ADMIN) {
  return { tenantId: TENANT, spaceName: 'spaces/team', text, mentions, sender };
}

async function seedWithBlocker(stack: Awaited<ReturnType<typeof makeStack>>) {
  const standup = await seedStandup(stack.repo);
  await stack.repo.addAdmin(standup.id, ADMIN.userName, ADMIN.displayName);
  const run = await stack.repo.createRun(standup.id, '2026-06-09', 'k1');
  await stack.service.submit(run.id, ALICE.userName, ALICE.displayName, withBlocker('Waiting on API keys'));
  const blocker = (await stack.repo.listOpenBlockers(standup.id))[0]!;
  return { standup, run, blocker };
}

describe('Blocker collaboration', () => {
  it('tags people via command: DM card, space thread post, no duplicate tags', async () => {
    const stack = await makeStack();
    const { blocker } = await seedWithBlocker(stack);

    const reply = await stack.commands.handle(ctx(`blocker ${blocker.id} tag @Bob`, [BOB]));
    expect(reply).toContain('Tagged Bob');
    expect(reply).toContain('explicit');

    const cards = stack.adapter.dms.filter((d) => d.kind === 'blockerCard');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.userName).toBe(BOB.userName);
    expect(cards[0]!.blockerId).toBe(blocker.id);

    const threadPosts = stack.adapter.posts.filter(
      (p) => p.kind === 'text' && p.threadKey === `blocker-${blocker.id}`,
    );
    expect(threadPosts).toHaveLength(1);
    expect(threadPosts[0]!.text).toContain('tagged Bob');

    expect(await stack.commands.handle(ctx(`blocker ${blocker.id} tag @Bob`, [BOB]))).toContain(
      'already tagged',
    );
    expect((await stack.repo.listBlockerTags(blocker.id))).toHaveLength(1);
  });

  it('exempts tagged blockers from auto-resolve; untagged ones still auto-resolve', async () => {
    const stack = await makeStack();
    const { standup, blocker } = await seedWithBlocker(stack);
    await stack.commands.handle(ctx(`blocker ${blocker.id} tag @Bob`, [BOB]));

    // Bob also reports a blocker (untagged)
    const run1 = (await stack.repo.getRun(standup.id, '2026-06-09'))!;
    await stack.service.submit(run1.id, BOB.userName, BOB.displayName, withBlocker('Bob blocker'));

    // next day both submit clean
    const run2 = await stack.repo.createRun(standup.id, '2026-06-10', 'k2');
    await stack.service.submit(run2.id, ALICE.userName, ALICE.displayName, ANSWERS);
    await stack.service.submit(run2.id, BOB.userName, BOB.displayName, ANSWERS);

    const open = await stack.repo.listOpenBlockers(standup.id);
    expect(open.map((b) => b.text)).toEqual(['Waiting on API keys']); // tagged one survives
  });

  it('acknowledge: records, notifies the owner, stops there for non-tagged users', async () => {
    const stack = await makeStack();
    const { blocker } = await seedWithBlocker(stack);
    await stack.commands.handle(ctx(`blocker ${blocker.id} tag @Bob`, [BOB]));

    expect(await stack.blockers.acknowledge(blocker.id, BOB)).toBe('acked');
    expect((await stack.repo.listBlockerTags(blocker.id))[0]!.acknowledgedAt).not.toBeNull();
    const ownerDm = stack.adapter.dms.find(
      (d) => d.kind === 'text' && d.userName === ALICE.userName && d.text?.includes('acknowledged'),
    );
    expect(ownerDm).toBeDefined();

    expect(await stack.blockers.acknowledge(blocker.id, BOB)).toBe('already_acked');
    expect(await stack.blockers.acknowledge(blocker.id, ADMIN)).toBe('not_tagged');
  });

  it('updates broadcast to owner and tagged people (not the author) and post to the thread', async () => {
    const stack = await makeStack();
    const { blocker } = await seedWithBlocker(stack);
    await stack.commands.handle(ctx(`blocker ${blocker.id} tag @Bob @Admin`, [BOB, ADMIN]));
    stack.adapter.dms.length = 0;

    expect(await stack.blockers.addUpdate(blocker.id, BOB, 'Requested keys from infra')).toBe('ok');

    const dms = stack.adapter.dms.filter((d) => d.kind === 'text');
    expect(dms.map((d) => d.userName).sort()).toEqual([ADMIN.userName, ALICE.userName]); // not Bob
    expect(dms[0]!.text).toContain('Requested keys from infra');

    const threadPosts = stack.adapter.posts.filter(
      (p) => p.kind === 'text' && p.threadKey === `blocker-${blocker.id}`,
    );
    expect(threadPosts.some((p) => p.text!.includes('Requested keys from infra'))).toBe(true);

    // posting an update acknowledges implicitly
    const bobTag = (await stack.repo.listBlockerTags(blocker.id)).find((t) => t.userName === BOB.userName)!;
    expect(bobTag.acknowledgedAt).not.toBeNull();
  });

  it('explicit resolve: allowed for tagged/owner/admin, blocked for others, broadcasts once', async () => {
    const stack = await makeStack();
    const { standup, blocker } = await seedWithBlocker(stack);
    await stack.commands.handle(ctx(`blocker ${blocker.id} tag @Bob`, [BOB]));

    const stranger = { userName: 'users/mallory', displayName: 'Mallory' };
    expect(await stack.blockers.resolve(blocker.id, stranger)).toBe('not_allowed');

    expect(await stack.commands.handle(ctx(`blocker ${blocker.id} resolve`, [], BOB))).toContain(
      'resolved',
    );
    const resolved = (await stack.repo.getBlockerById(blocker.id))!;
    expect(resolved.resolvedDate).not.toBeNull();
    expect(resolved.resolvedBy).toBe(BOB.displayName);
    expect(await stack.repo.listOpenBlockers(standup.id)).toHaveLength(0);

    expect(await stack.blockers.resolve(blocker.id, BOB)).toBe('already_resolved');
  });

  it('nudges unacked tags once per day at run close, stops after ack', async () => {
    const stack = await makeStack();
    const { blocker } = await seedWithBlocker(stack);
    stack.clock.set('2026-06-09T12:00');
    await stack.commands.handle(ctx(`blocker ${blocker.id} tag @Bob`, [BOB]));
    stack.adapter.dms.length = 0;

    // next day's run closes → one nudge
    stack.clock.set('2026-06-10T09:30');
    await stack.scheduler.tick();
    stack.clock.set('2026-06-10T11:30');
    await stack.scheduler.tick();
    let nudges = stack.adapter.dms.filter((d) => d.kind === 'blockerCard');
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.userName).toBe(BOB.userName);
    expect(nudges[0]!.text).toContain('acknowledge');

    // same day, another tick → still one
    await stack.scheduler.tick();
    expect(stack.adapter.dms.filter((d) => d.kind === 'blockerCard')).toHaveLength(1);

    // Bob acks → no nudge the following day
    await stack.blockers.acknowledge(blocker.id, BOB);
    stack.clock.set('2026-06-11T09:30');
    await stack.scheduler.tick();
    stack.clock.set('2026-06-11T11:30');
    await stack.scheduler.tick();
    expect(stack.adapter.dms.filter((d) => d.kind === 'blockerCard')).toHaveLength(1);
  });

  it('card buttons work end-to-end through the event router', async () => {
    const stack = await makeStack();
    const { blocker } = await seedWithBlocker(stack);
    await stack.commands.handle(ctx(`blocker ${blocker.id} tag @Bob`, [BOB]));
    const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
    const user = { name: BOB.userName, displayName: BOB.displayName };

    const ack: any = await router.handle({
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'ackBlocker', parameters: { blockerId: String(blocker.id) } },
      user,
    });
    expect(ack.text).toContain('Acknowledged');

    const dialog: any = await router.handle({
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'openBlockerUpdate', parameters: { blockerId: String(blocker.id) } },
      user,
    });
    expect(dialog.actionResponse.type).toBe('DIALOG');
    expect(JSON.stringify(dialog)).toContain('submitBlockerUpdate');

    const update: any = await router.handle({
      type: 'CARD_CLICKED',
      isDialogEvent: true,
      common: {
        invokedFunction: 'submitBlockerUpdate',
        parameters: { blockerId: String(blocker.id) },
        formInputs: { update: { stringInputs: { value: ['Keys arriving tomorrow'] } } },
      },
      user,
    });
    expect(update.actionResponse.dialogAction.actionStatus.statusCode).toBe('OK');
    expect((await stack.repo.listBlockerUpdates(blocker.id))[0]!.text).toBe('Keys arriving tomorrow');

    const resolve: any = await router.handle({
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'resolveBlocker', parameters: { blockerId: String(blocker.id) } },
      user,
    });
    expect(resolve.text).toContain('resolved');
  });

  it('lists blockers with ids, tags, acks, and update counts', async () => {
    const stack = await makeStack();
    const { blocker } = await seedWithBlocker(stack);
    await stack.commands.handle(ctx(`blocker ${blocker.id} tag @Bob`, [BOB]));
    await stack.blockers.addUpdate(blocker.id, BOB, 'On it');

    const listing = await stack.commands.handle(ctx('blockers'));
    expect(listing).toContain(`#${blocker.id}`);
    expect(listing).toContain('Bob ✋'); // update implies ack
    expect(listing).toContain('1 update');
  });
});
