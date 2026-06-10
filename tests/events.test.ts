import { describe, expect, it } from 'vitest';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { ANSWERS, makeStack, seedStandup, TENANT } from './helpers.js';

function makeRouter() {
  const stack = makeStack();
  const router = new EventRouter(stack.commands, stack.service, TENANT);
  return { ...stack, router };
}

function dialogSubmitEvent(runId: number, inputs: Partial<Record<string, string>>, user = 'users/alice') {
  const formInputs: any = {};
  for (const [name, value] of Object.entries(inputs)) {
    formInputs[name] = { stringInputs: { value: [value] } };
  }
  return {
    type: 'CARD_CLICKED',
    isDialogEvent: true,
    common: { invokedFunction: 'submitStandup', parameters: { runId: String(runId) }, formInputs },
    user: { name: user, displayName: 'Alice', type: 'HUMAN' },
    space: { name: 'spaces/dm-alice', spaceType: 'DIRECT_MESSAGE' },
  };
}

describe('EventRouter', () => {
  it('routes space messages to the command handler with mentions', async () => {
    const { router, repo } = makeRouter();
    const reply: any = await router.handle({
      type: 'MESSAGE',
      space: { name: 'spaces/team', type: 'ROOM' },
      message: {
        argumentText: ' setup Platform',
        annotations: [
          {
            type: 'USER_MENTION',
            userMention: { user: { name: 'users/bot', displayName: 'Standup Bot', type: 'BOT' } },
          },
        ],
      },
      user: { name: 'users/admin', displayName: 'Admin' },
    });
    expect(reply.text).toContain('Platform');
    expect(repo.getStandupBySpace(TENANT, 'spaces/team')?.name).toBe('Platform');
  });

  it('extracts human mentions and ignores the bot', async () => {
    const { router, repo } = makeRouter();
    await router.handle({
      type: 'MESSAGE',
      space: { name: 'spaces/team', type: 'ROOM' },
      message: { argumentText: 'setup' },
    });
    const reply: any = await router.handle({
      type: 'MESSAGE',
      space: { name: 'spaces/team', type: 'ROOM' },
      message: {
        argumentText: 'add @Alice',
        annotations: [
          {
            type: 'USER_MENTION',
            userMention: { user: { name: 'users/bot', displayName: 'Bot', type: 'BOT' } },
          },
          {
            type: 'USER_MENTION',
            userMention: { user: { name: 'users/alice', displayName: 'Alice', type: 'HUMAN' } },
          },
        ],
      },
    });
    expect(reply.text).toContain('Added Alice');
    const standup = repo.getStandupBySpace(TENANT, 'spaces/team')!;
    expect(repo.listParticipants(standup.id).map((p) => p.userName)).toEqual(['users/alice']);
  });

  it('answers DMs with a hint instead of running commands', async () => {
    const { router } = makeRouter();
    const reply: any = await router.handle({
      type: 'MESSAGE',
      space: { name: 'spaces/dm', spaceType: 'DIRECT_MESSAGE' },
      message: { text: 'setup' },
    });
    expect(reply.text).toContain('Fill standup');
  });

  it('opens the dialog on card click', async () => {
    const { router } = makeRouter();
    const reply: any = await router.handle({
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'openStandupDialog', parameters: { runId: '7' } },
    });
    expect(reply.actionResponse.type).toBe('DIALOG');
    expect(reply.actionResponse.dialogAction.dialog).toBeDefined();
  });

  it('records a dialog submission and posts it to the thread', async () => {
    const { router, repo, adapter } = makeRouter();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');

    const reply: any = await router.handle(dialogSubmitEvent(run.id, { ...ANSWERS }));
    expect(reply.actionResponse.dialogAction.actionStatus.statusCode).toBe('OK');
    expect(repo.getSubmission(run.id, 'users/alice')?.today).toBe(ANSWERS.today);
    expect(adapter.posts.filter((p) => p.kind === 'submission')).toHaveLength(1);
  });

  it('validates required fields and mood', async () => {
    const { router, repo } = makeRouter();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');

    const missing: any = await router.handle(dialogSubmitEvent(run.id, { yesterday: 'x' }));
    expect(missing.actionResponse.dialogAction.actionStatus.statusCode).toBe('INVALID_ARGUMENT');

    const badMood: any = await router.handle(
      dialogSubmitEvent(run.id, { yesterday: 'x', today: 'y', mood: 'ecstatic' }),
    );
    expect(badMood.actionResponse.dialogAction.actionStatus.statusCode).toBe('INVALID_ARGUMENT');
    expect(repo.getSubmission(run.id, 'users/alice')).toBeNull();
  });

  it('reports duplicate submissions kindly', async () => {
    const { router, repo } = makeRouter();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');
    await router.handle(dialogSubmitEvent(run.id, { ...ANSWERS }));
    const dup: any = await router.handle(dialogSubmitEvent(run.id, { ...ANSWERS }));
    expect(dup.actionResponse.dialogAction.actionStatus.userFacingMessage).toContain('already submitted');
  });

  it('welcomes when added to a space', async () => {
    const { router } = makeRouter();
    const reply: any = await router.handle({
      type: 'ADDED_TO_SPACE',
      space: { name: 'spaces/team', type: 'ROOM' },
    });
    expect(reply.text).toContain('setup');
  });
});
