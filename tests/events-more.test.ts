import { describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

async function makeRouter() {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  return { ...stack, router };
}

const ALICE = { name: 'users/alice', displayName: 'Alice' };

describe('EventRouter action parameters', () => {
  it('reads list-shaped common.parameters from card clicks', async () => {
    const { router, repo } = await makeRouter();
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, '2026-06-10', 'key');

    const reply: any = await router.handle({
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'skipToday', parameters: [{ key: 'runId', value: String(run.id) }] },
      user: ALICE,
    });
    expect(reply.text).toContain('Skipped');
    expect(
      (await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/alice')?.skippedAt,
    ).not.toBeNull();
  });

  it('falls back to action.parameters when common carries no parameters', async () => {
    const { router } = await makeRouter();
    const reply: any = await router.handle({
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'openBlockerUpdate' },
      action: { parameters: [{ key: 'blockerId', value: '5' }] },
      user: ALICE,
    });
    expect(JSON.stringify(reply)).toContain('{"key":"blockerId","value":"5"}');
  });

  it('falls back to action.parameters when the map form lacks the key', async () => {
    const { router } = await makeRouter();
    const reply: any = await router.handle({
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'openBlockerUpdate', parameters: { runId: '1' } },
      action: { parameters: [{ key: 'blockerId', value: '9' }] },
      user: ALICE,
    });
    expect(JSON.stringify(reply)).toContain('{"key":"blockerId","value":"9"}');
  });

  it('rejects a blocker update dialog with no usable blockerId', async () => {
    const { router } = await makeRouter();
    const reply: any = await router.handle({
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'openBlockerUpdate' },
      action: { parameters: [{ key: 'runId', value: '1' }] },
      user: ALICE,
    });
    expect(reply.actionResponse.dialogAction.actionStatus.statusCode).toBe('INVALID_ARGUMENT');
  });
});
