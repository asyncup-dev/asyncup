import { describe, expect, it } from 'bun:test';
import type { chat_v1 } from '@googleapis/chat';
import { GoogleChatAdapter } from '../src/adapters/gchat/adapter.js';
import { promptMessage, tagBlockerDialog } from '../src/adapters/gchat/cards.js';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { nudgeToday } from '../src/api/actions.js';
import { StandupService } from '../src/core/standup-service.js';
import { ANSWERS, makeStack, seedStandup, TENANT, withBlocker } from './helpers.js';

const ALICE = { name: 'users/alice', displayName: 'Alice', type: 'HUMAN' };

/** Today's run (Wed 10 Jun) opened by the scheduler, so Alice's prompt card is on record. */
async function promptedRun() {
  const stack = await makeStack();
  const standup = await seedStandup(stack.repo);
  stack.clock.set('2026-06-10T09:30');
  await stack.scheduler.tick();
  const run = (await stack.repo.getRun(standup.id, '2026-06-10'))!;
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  return { ...stack, standup, run, router };
}
const textOf = (reply: any) => reply.cardsV2[0].card.sections[0].widgets[0].textParagraph.text as string;
const buttonsOf = (reply: any) => reply.cardsV2[0].card.sections[0].widgets[1].buttonList.buttons.map((b: any) => b.text);

describe('prompt cards follow where the person stands', () => {
  it('remembers every card sent, and rewrites them on submit, edit, skip and undo', async () => {
    const { repo, run, service, adapter, scheduler, clock, standup } = await promptedRun();
    expect(await repo.listCardMessages(run.id, 'users/alice')).toEqual(['messages/fake-1']);
    clock.set('2026-06-10T10:30'); // the reminder goes out
    await scheduler.tick();
    await nudgeToday(repo, adapter, standup, clock.now());
    const cards = await repo.listCardMessages(run.id, 'users/alice');
    expect(cards).toHaveLength(3);
    await repo.addCardMessage(run.id, 'users/alice', cards[0]!); // no duplicates
    await repo.addCardMessage(run.id, 'users/zed', 'messages/x'); // not on the run
    expect(await repo.listCardMessages(run.id, 'users/alice')).toHaveLength(3);

    expect(await service.skipToday(run.id, 'users/alice')).toBe('skipped');
    expect(adapter.cardUpdates.at(-1)).toEqual({ messageNames: cards, runId: run.id, state: { kind: 'skipped' } });
    expect(await service.unskip(run.id, 'users/alice')).toBe('unskipped');
    expect(adapter.cardUpdates.at(-1)!.state).toEqual({ kind: 'open' });
    expect((await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/alice')).toMatchObject({ skippedAt: null, awayReason: null });
    expect(await service.unskip(run.id, 'users/alice')).toBe('not_skipped');

    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    expect(adapter.cardUpdates.at(-1)!.state).toMatchObject({ kind: 'submitted', late: false });
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS); // an edit
    expect(adapter.cardUpdates.at(-1)!.state.kind).toBe('submitted');

    clock.set('2026-06-10T12:00');
    await scheduler.tick(); // closes the run
    expect(await service.unskip(run.id, 'users/bob')).toBe('closed');
    expect(await service.unskip(999, 'users/bob')).toBe('not_found');
  });

  it('logs a card that cannot be rewritten instead of failing the submission, and skips people with no cards', async () => {
    const { repo, adapter, run, clock } = await promptedRun();
    const logs: string[] = [];
    adapter.updateStandupCards = async () => {
      throw new Error('message deleted');
    };
    const service = new StandupService(repo, adapter, clock.now, null, (m) => logs.push(m));
    expect((await service.submit(run.id, 'users/alice', 'Alice', ANSWERS)).ok).toBe(true);
    expect(logs).toEqual([`updating users/alice's cards for run ${run.id} failed: Error: message deleted`]);
    // carol was never prompted on this run, so there is nothing to rewrite
    await repo.markSkipped(run.id, 'users/carol', '2026-06-10T10:00:00Z');
    const quiet = new StandupService(repo, adapter, clock.now);
    expect(await quiet.unskip(run.id, 'users/carol')).toBe('unskipped');
  });

  it('builds the open, submitted and skipped cards', async () => {
    const { standup, run } = await promptedRun();
    expect(buttonsOf(promptMessage(standup, run))).toEqual(['Fill standup', '🏖️ Skip today']);
    const submitted = promptMessage(standup, run, null, { kind: 'submitted', at: '2026-06-10T04:35:00Z', late: true });
    expect(textOf(submitted)).toBe('✅ Submitted at <b>10:05</b> (late). You can edit your answers until <b>11:30 Asia/Kolkata</b>.');
    expect(buttonsOf(submitted)).toEqual(['Edit answers']);
    expect(buttonsOf(promptMessage(standup, run, null, { kind: 'skipped' }))).toEqual(['↩️ Undo skip']);
  });
});

describe('skip and undo from Chat', () => {
  const click = (fn: string, runId: number) => ({ type: 'CARD_CLICKED', common: { invokedFunction: fn, parameters: { runId: String(runId) } }, user: ALICE });

  it('swaps the clicked card between skipped and open, and shows submitted once answered', async () => {
    const { router, run, service, clock, scheduler } = await promptedRun();
    let reply: any = await router.handle(click('skipToday', run.id));
    expect(buttonsOf(reply)).toEqual(['↩️ Undo skip']);
    reply = await router.handle(click('unskipToday', run.id));
    expect(buttonsOf(reply)).toEqual(['Fill standup', '🏖️ Skip today']);
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    reply = await router.handle(click('skipToday', run.id));
    expect(buttonsOf(reply)).toEqual(['Edit answers']);
    expect((await router.handle(click('skipToday', 999)) as any).text).toBe('This standup prompt is no longer valid.');
    expect((await router.handle(click('unskipToday', 999)) as any).text).toBe('This standup prompt is no longer valid.');

    await router.handle(click('skipToday', run.id)); // bob-style skip by someone who hasn't answered
    clock.set('2026-06-10T12:00');
    await scheduler.tick();
    const closed: any = await router.handle({ ...click('unskipToday', run.id), user: { name: 'users/bob', displayName: 'Bob', type: 'HUMAN' } });
    expect(closed.text).toBe("Today's Daily Standup has closed, so the skip stays.");
  });

  it('reports a skip that no longer matches anyone on the run', async () => {
    const { router, run } = await promptedRun();
    const stranger: any = await router.handle({ ...click('skipToday', run.id), user: { name: 'users/zed', displayName: 'Zed', type: 'HUMAN' } });
    expect(stranger.text).toBe('This standup prompt is no longer valid.');
  });

  it('takes back skips by DM', async () => {
    const { router, run, service } = await promptedRun();
    const dm = (text: string) => router.handle({ type: 'MESSAGE', message: { text }, user: ALICE, space: { name: 'spaces/dm-alice', type: 'DM', spaceType: 'DIRECT_MESSAGE' } });
    expect(((await dm('unskip')) as any).text).toBe("Nothing to undo: you haven't skipped an open standup today.");
    await service.skipToday(run.id, 'users/alice');
    expect(((await dm('unskip')) as any).text).toBe("↩️ Skip undone for Daily Standup — your prompt card is back, and you're expected today.");
    expect(((await dm('help')) as any).text).toContain('`unskip`');
  });
});

describe('tagging people on a blocker from Chat', () => {
  it('DMs the owner a card to pull people in, and tags whoever they pick', async () => {
    const { router, run, service, adapter, blockers } = await promptedRun();
    await service.submit(run.id, 'users/alice', 'Alice', withBlocker('Waiting on API keys'));
    const owner = adapter.dms.find((d) => d.kind === 'blockerCard' && d.owner)!;
    expect(owner).toMatchObject({ userName: 'users/alice', text: 'Your blocker is open. Tag the people who can help.' });
    const blockerId = owner.blockerId!;

    const tagEvent = (fn: string, people: string[] = [], id = blockerId) => ({
      type: 'CARD_CLICKED',
      isDialogEvent: fn === 'submitTagBlocker',
      common: { invokedFunction: fn, parameters: { blockerId: String(id) }, formInputs: { people: { stringInputs: { value: people } } } },
      user: ALICE,
    });
    const dialog: any = await router.handle(tagEvent('openTagBlocker'));
    expect(dialog.actionResponse.dialogAction.dialog.body.sections[0].widgets[1].selectionInput).toMatchObject({ type: 'MULTI_SELECT', platformDataSource: { commonDataSource: 'USER' } });

    const none: any = await router.handle(tagEvent('submitTagBlocker', ['users/alice', 'not-a-user']));
    expect(none.actionResponse.dialogAction.actionStatus.statusCode).toBe('INVALID_ARGUMENT');
    const done: any = await router.handle(tagEvent('submitTagBlocker', ['users/bob', 'users/outsider']));
    expect(done.actionResponse.dialogAction.actionStatus.userFacingMessage).toContain('Tagged Bob, A teammate');
    expect(adapter.dms.filter((d) => d.kind === 'blockerCard' && !d.owner).map((d) => d.userName)).toEqual(['users/bob', 'users/outsider']);

    expect(await blockers.resolve(blockerId, { userName: 'users/alice', displayName: 'Alice' })).toBe('resolved');
    const resolved: any = await router.handle(tagEvent('openTagBlocker'));
    expect(resolved.actionResponse.dialogAction.actionStatus.userFacingMessage).toBe('This blocker is resolved or no longer exists.');
    expect(((await router.handle(tagEvent('submitTagBlocker', ['users/bob'], 999))) as any).actionResponse.dialogAction.actionStatus.statusCode).toBe('INVALID_ARGUMENT');
  });

  it('logs an owner card that cannot be delivered', async () => {
    const { repo, adapter, run, clock } = await promptedRun();
    adapter.sendBlockerCard = async () => {
      throw new Error('dm blocked');
    };
    const logs: string[] = [];
    const service = new StandupService(repo, adapter, clock.now, null, (m) => logs.push(m));
    expect((await service.submit(run.id, 'users/alice', 'Alice', withBlocker('Waiting on API keys'))).ok).toBe(true);
    expect(logs).toEqual(['blocker card to users/alice failed: Error: dm blocked']);
  });

  it('builds the tag dialog for the blocker', () => {
    const dialog: any = tagBlockerDialog({ id: 7, text: 'CI is red' } as any, 'https://x/chat/events');
    const widgets = dialog.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    expect(widgets[0].textParagraph.text).toBe('CI is red');
    expect(widgets[2].buttonList.buttons[0].onClick.action.parameters).toEqual([{ key: 'fn', value: 'submitTagBlocker' }, { key: 'blockerId', value: '7' }]);
  });
});

describe('GoogleChatAdapter prompt cards', () => {
  it('returns the name of each card it sends, and rewrites cards in place', async () => {
    const { repo, settings, standup, run } = await promptedRun();
    const calls: { method: string; params: any }[] = [];
    let n = 0;
    const client = {
      spaces: {
        findDirectMessage: async (params: any) => ({ data: { name: `spaces/dm-${params.name.split('/')[1]}` } }),
        messages: {
          create: async (params: any) => {
            calls.push({ method: 'create', params });
            return { data: n++ === 0 ? { name: 'spaces/dm-alice/messages/1' } : {} };
          },
          update: async (params: any) => {
            calls.push({ method: 'update', params });
            return { data: {} };
          },
        },
      },
    } as unknown as chat_v1.Chat;
    const gchat = new GoogleChatAdapter(repo, settings, () => client);
    expect(await gchat.sendStandupPrompt('users/alice', standup, run)).toBe('spaces/dm-alice/messages/1');
    expect(await gchat.sendReminder('users/alice', standup, run)).toBeNull();
    await gchat.updateStandupCards(['m/1', 'm/2'], standup, run, { kind: 'skipped' });
    const updates = calls.filter((c) => c.method === 'update');
    expect(updates.map((u) => [u.params.name, u.params.updateMask])).toEqual([
      ['m/1', 'cardsV2'],
      ['m/2', 'cardsV2'],
    ]);
    expect(textOf(updates[0]!.params.requestBody)).toContain('You skipped today');
  });
});
