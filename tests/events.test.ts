import { describe, expect, it } from 'vitest';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { ANSWERS, makeStack, seedStandup, TENANT } from './helpers.js';

async function makeRouter() {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.repo, TENANT);
  return { ...stack, router };
}

const SENDER = { name: 'users/admin', displayName: 'Admin', type: 'HUMAN' };

function dialogSubmitEvent(
  runId: number,
  inputs: Partial<Record<string, string>>,
  user = { name: 'users/alice', displayName: 'Alice', type: 'HUMAN' },
) {
  const formInputs: any = {};
  for (const [name, value] of Object.entries(inputs)) {
    formInputs[name] = { stringInputs: { value: [value] } };
  }
  return {
    type: 'CARD_CLICKED',
    isDialogEvent: true,
    common: { invokedFunction: 'submitStandup', parameters: { runId: String(runId) }, formInputs },
    user,
    space: { name: 'spaces/dm-alice', spaceType: 'DIRECT_MESSAGE' },
  };
}

const FULL_FORM = { q0: 'Did X', q1: 'Will do Y', q2: 'none', mood: 'good' };

describe('EventRouter', () => {
  it('routes space messages to the command handler with sender and mentions', async () => {
    const { router, repo } = await makeRouter();
    const reply: any = await router.handle({
      type: 'MESSAGE',
      space: { name: 'spaces/team', type: 'ROOM' },
      message: { argumentText: ' setup Platform' },
      user: SENDER,
    });
    expect(reply.text).toContain('Platform');
    const standup = (await repo.listStandupsBySpace(TENANT, 'spaces/team'))[0]!;
    expect(await repo.isAdmin(standup.id, 'users/admin')).toBe(true);
  });

  it('extracts human mentions and ignores the bot', async () => {
    const { router, repo } = await makeRouter();
    await router.handle({
      type: 'MESSAGE',
      space: { name: 'spaces/team', type: 'ROOM' },
      message: { argumentText: 'setup' },
      user: SENDER,
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
      user: SENDER,
    });
    expect(reply.text).toContain('Added Alice');
    const standup = (await repo.listStandupsBySpace(TENANT, 'spaces/team'))[0]!;
    expect((await repo.listParticipants(standup.id)).map((p) => p.userName)).toEqual(['users/alice']);
  });

  it('handles DM self-service vacation and back', async () => {
    const { router, repo } = await makeRouter();
    const standup = await seedStandup(repo);
    const dm = (text: string) => ({
      type: 'MESSAGE',
      space: { name: 'spaces/dm', spaceType: 'DIRECT_MESSAGE' },
      message: { text },
      user: { name: 'users/alice', displayName: 'Alice' },
    });

    const on: any = await router.handle(dm('vacation'));
    expect(on.text).toContain('Vacation mode ON');
    expect(
      (await repo.listParticipants(standup.id)).find((p) => p.userName === 'users/alice')?.onVacation,
    ).toBe(true);

    const off: any = await router.handle(dm('back'));
    expect(off.text).toContain('Welcome back');

    const hint: any = await router.handle(dm('hello there'));
    expect(hint.text).toContain('Fill standup');
  });

  it('opens a prefilled dialog from the prompt card', async () => {
    const { router, repo, service } = await makeRouter();
    const standup = await seedStandup(repo);
    const run1 = await repo.createRun(standup.id, '2026-06-09', 'k1');
    await service.submit(run1.id, 'users/alice', 'Alice', ANSWERS);
    const run2 = await repo.createRun(standup.id, '2026-06-10', 'k2');

    const reply: any = await router.handle({
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'openStandupDialog', parameters: { runId: String(run2.id) } },
      user: { name: 'users/alice', displayName: 'Alice' },
    });
    const widgets = reply.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    expect(widgets[0].textInput.value).toBe('Start billing webhooks');
    expect(widgets[1].textInput.value).toBeUndefined();
  });

  it('records a dialog submission and posts it to the thread', async () => {
    const { router, repo, adapter } = await makeRouter();
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, '2026-06-10', 'key');

    const reply: any = await router.handle(dialogSubmitEvent(run.id, FULL_FORM));
    expect(reply.actionResponse.dialogAction.actionStatus.statusCode).toBe('OK');
    const sub = (await repo.getSubmission(run.id, 'users/alice'))!;
    expect(sub.answers[1]!.answer).toBe('Will do Y');
    expect(adapter.posts.filter((p) => p.kind === 'submission')).toHaveLength(1);
  });

  it('edits via resubmission with a friendly confirmation', async () => {
    const { router, repo, adapter } = await makeRouter();
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, '2026-06-10', 'key');
    await router.handle(dialogSubmitEvent(run.id, FULL_FORM));

    const edit: any = await router.handle(dialogSubmitEvent(run.id, { ...FULL_FORM, q1: 'Changed plan' }));
    expect(edit.actionResponse.dialogAction.actionStatus.userFacingMessage).toContain('Updated');
    expect((await repo.getSubmission(run.id, 'users/alice'))!.answers[1]!.answer).toBe('Changed plan');
    expect(adapter.posts.filter((p) => p.kind === 'update')).toHaveLength(1);
  });

  it('validates required answers and mood', async () => {
    const { router, repo } = await makeRouter();
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, '2026-06-10', 'key');

    const missing: any = await router.handle(dialogSubmitEvent(run.id, { q0: 'x', mood: 'good' }));
    expect(missing.actionResponse.dialogAction.actionStatus.statusCode).toBe('INVALID_ARGUMENT');

    const badMood: any = await router.handle(
      dialogSubmitEvent(run.id, { q0: 'x', q1: 'y', q2: 'none', mood: 'ecstatic' }),
    );
    expect(badMood.actionResponse.dialogAction.actionStatus.statusCode).toBe('INVALID_ARGUMENT');

    // blockers (q2) may be empty; defaults to "none"
    const ok: any = await router.handle(dialogSubmitEvent(run.id, { q0: 'x', q1: 'y', mood: 'good' }));
    expect(ok.actionResponse.dialogAction.actionStatus.statusCode).toBe('OK');
    expect((await repo.getSubmission(run.id, 'users/alice'))!.answers[2]!.answer).toBe('none');
  });

  it('skips mood validation when the mood question is disabled', async () => {
    const { router, repo } = await makeRouter();
    const standup = await seedStandup(repo);
    await repo.updateStandup(standup.id, { moodEnabled: false });
    const run = await repo.createRun(standup.id, '2026-06-10', 'key');

    const reply: any = await router.handle(dialogSubmitEvent(run.id, { q0: 'x', q1: 'y' }));
    expect(reply.actionResponse.dialogAction.actionStatus.statusCode).toBe('OK');
    expect((await repo.getSubmission(run.id, 'users/alice'))!.mood).toBeNull();
  });

  it('handles the skip button with a card update', async () => {
    const { router, repo } = await makeRouter();
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, '2026-06-10', 'key');

    const reply: any = await router.handle({
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'skipToday', parameters: { runId: String(run.id) } },
      user: { name: 'users/alice', displayName: 'Alice' },
    });
    expect(reply.actionResponse.type).toBe('UPDATE_MESSAGE');
    expect(reply.text).toContain('Skipped');
    expect(
      (await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/alice')?.skippedAt,
    ).not.toBeNull();
  });

  it('welcomes when added to a space', async () => {
    const { router } = await makeRouter();
    const reply: any = await router.handle({
      type: 'ADDED_TO_SPACE',
      space: { name: 'spaces/team', type: 'ROOM' },
    });
    expect(reply.text).toContain('setup');
  });
});
