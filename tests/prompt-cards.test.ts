import { describe, expect, it } from 'bun:test';
import type { chat_v1 } from '@googleapis/chat';
import { GoogleChatAdapter } from '../src/adapters/gchat/adapter.js';
import { promptMessage, skipText, tagBlockerDialog } from '../src/adapters/gchat/cards.js';
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

    const alice = async () => (await repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/alice')!;
    expect(await service.skipToday(run.id, 'users/alice', 'Dentist')).toBe('skipped');
    expect(adapter.cardUpdates.at(-1)).toEqual({ messageNames: cards, runId: run.id, state: { kind: 'skipped', note: 'Dentist' } });
    const first = adapter.posts.at(-1)!;
    expect(first).toMatchObject({ kind: 'skip', threadKey: run.threadKey, text: 'Alice: Dentist' });
    expect(await alice()).toMatchObject({ awayReason: 'skipped', skipNote: 'Dentist', skipMessage: first.messageName });
    // a second skip replaces the reason and its thread reply
    expect(await service.skipToday(run.id, 'users/alice', 'Dentist, then school run')).toBe('skipped');
    const second = adapter.posts.at(-1)!;
    expect(adapter.deleted).toEqual([first.messageName!]);
    expect(await service.unskip(run.id, 'users/alice')).toBe('unskipped');
    expect(adapter.deleted).toEqual([first.messageName!, second.messageName!]);
    expect(adapter.cardUpdates.at(-1)!.state).toEqual({ kind: 'open' });
    expect(await alice()).toMatchObject({ skippedAt: null, awayReason: null, skipNote: null, skipMessage: null });
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
    await repo.markSkipped(run.id, 'users/carol', '2026-06-10T10:00:00Z', 'Sick');
    const quiet = new StandupService(repo, adapter, clock.now);
    expect(await quiet.unskip(run.id, 'users/carol')).toBe('unskipped');

    // the thread being unreachable never blocks a skip or its undo
    adapter.postSkip = async () => {
      throw new Error('space gone');
    };
    logs.length = 0;
    expect(await service.skipToday(run.id, 'users/bob', 'Offsite')).toBe('skipped');
    await repo.setSkipMessage(run.id, 'users/bob', 'messages/old');
    adapter.deleteMessage = async () => {
      throw new Error('already deleted');
    };
    expect(await service.unskip(run.id, 'users/bob')).toBe('unskipped');
    expect(logs).toEqual([
      `posting users/bob's skip for run ${run.id} failed: Error: space gone`,
      `updating users/bob's cards for run ${run.id} failed: Error: message deleted`,
      'deleting messages/old failed: Error: already deleted',
      `updating users/bob's cards for run ${run.id} failed: Error: message deleted`,
    ]);
    expect(await service.skipToday(run.id, 'users/zed', 'x')).toBe('not_found');
  });

  it('builds the open, submitted and skipped cards', async () => {
    const { standup, run } = await promptedRun();
    expect(buttonsOf(promptMessage(standup, run))).toEqual(['Fill standup', '🏖️ Skip today']);
    const submitted = promptMessage(standup, run, null, { kind: 'submitted', at: '2026-06-10T04:35:00Z', late: true });
    expect(textOf(submitted)).toBe('✅ Submitted at <b>10:05</b> (late). You can edit your answers until <b>11:30 Asia/Kolkata</b>.');
    expect(buttonsOf(submitted)).toEqual(['Edit answers']);
    const skipped = promptMessage(standup, run, null, { kind: 'skipped', note: 'Vet <3 & co' });
    expect(textOf(skipped)).toBe('🏖️ You skipped today: <i>Vet &lt;3 &amp; co</i>. You won’t be counted as missing. Changed your mind? Undo it before <b>11:30 Asia/Kolkata</b>.');
    expect(buttonsOf(skipped)).toEqual(['↩️ Undo skip']);
    expect(textOf(promptMessage(standup, run, null, { kind: 'skipped', note: null }))).toStartWith('🏖️ You skipped today. You won’t');
    expect(skipText('Alice', 'out <users/all>')).toBe('🏖️ *Alice* is skipping today: out ‹users/all›');
  });
});

describe('taking someone off a standup mid-run', () => {
  const mention = (name: string) => ({ userName: `users/${name.toLowerCase()}`, displayName: name });

  it('drops them from the open run and rewrites their cards, unless they already answered', async () => {
    const { repo, run, service, adapter, commands, standup, clock, scheduler } = await promptedRun();
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    const bobCards = await repo.listCardMessages(run.id, 'users/bob');
    const reply = await commands.handle({ tenantId: TENANT, spaceName: 'spaces/team', text: 'remove @Alice @Bob', mentions: [mention('Alice'), mention('Bob')], sender: mention('Alice') });
    expect(reply).toBe('✅ Removed Alice, Bob.');
    expect((await repo.listRunParticipants(run.id)).map((p) => p.userName)).toEqual(['users/alice', 'users/carol']);
    expect(adapter.cardUpdates.at(-1)).toEqual({ messageNames: bobCards, runId: run.id, state: { kind: 'removed' } });
    expect(textOf(promptMessage(standup, run, null, { kind: 'removed' }))).toBe('You’re no longer on this standup, so there’s nothing to answer today.');

    // a closed run keeps who it expected
    clock.set('2026-06-10T12:00');
    await scheduler.tick();
    await service.leaveOpenRuns(standup, 'users/carol');
    expect((await repo.listRunParticipants(run.id)).map((p) => p.userName)).toEqual(['users/alice', 'users/carol']);
  });

  it('logs a card that cannot be rewritten, and skips people never prompted', async () => {
    const { repo, adapter, run, clock, standup } = await promptedRun();
    const logs: string[] = [];
    adapter.updateStandupCards = async () => {
      throw new Error('message deleted');
    };
    const service = new StandupService(repo, adapter, clock.now, null, (m) => logs.push(m));
    await service.leaveOpenRuns(standup, 'users/bob');
    expect(logs).toEqual([`updating users/bob's cards for run ${run.id} failed: Error: message deleted`]);
    await repo.upsertParticipant({ standupId: standup.id, userName: 'users/dan', displayName: 'Dan' });
    await service.leaveOpenRuns(standup, 'users/dan'); // on the roster, not on the run
    expect(logs).toHaveLength(1);
  });
});

describe('skip and undo from Chat', () => {
  const click = (fn: string, runId: number, user: object = ALICE) => ({ type: 'CARD_CLICKED', common: { invokedFunction: fn, parameters: { runId: String(runId) } }, user });
  const skipWith = (runId: number, reason: string, user: object = ALICE) => ({
    ...click('skipToday', runId, user),
    isDialogEvent: true,
    common: { invokedFunction: 'skipToday', parameters: { runId: String(runId) }, formInputs: { reason: { stringInputs: { value: [reason] } } } },
  });
  const status = (reply: any) => reply.actionResponse.dialogAction.actionStatus;

  it('asks why in a dialog, tells the thread, and swaps back on undo', async () => {
    const { router, run, service, adapter, clock, scheduler } = await promptedRun();
    const dialog: any = await router.handle(click('openSkipDialog', run.id));
    const widgets = dialog.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    expect(widgets[0].textInput).toEqual({ name: 'reason', label: 'Why are you skipping today? (required)', type: 'SINGLE_LINE', hintText: 'One line, up to 150 characters. Your team sees it in today’s thread.' });
    expect(widgets[1].buttonList.buttons[0].onClick.action).toEqual({ function: 'skipToday', parameters: [{ key: 'runId', value: String(run.id) }] });

    // an empty or long reason redraws the dialog with the problem on top and the text kept
    const redrawn = (reply: any) => reply.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    const empty = redrawn(await router.handle(skipWith(run.id, '   ')));
    expect(empty[0].textParagraph.text).toBe('<font color="#d93025"><b>⚠️ Say in a line why you are skipping today.</b></font>');
    expect(empty[1].textInput.value).toBe('   ');
    const long = redrawn(await router.handle(skipWith(run.id, 'x'.repeat(151))));
    expect(long[0].textParagraph.text).toContain('Keep the reason to 150 characters.');
    expect(long[1].textInput.value).toBe('x'.repeat(151));
    expect(adapter.posts.filter((p) => p.kind === 'skip')).toHaveLength(0);
    expect(status(await router.handle(skipWith(run.id, 'Dentist\nthen school')))).toMatchObject({ statusCode: 'OK', userFacingMessage: '🏖️ Skipped. Your team can see why in today’s thread.' });
    expect(adapter.posts.at(-1)).toMatchObject({ kind: 'skip', text: 'Alice: Dentist then school' });
    expect(adapter.cardUpdates.at(-1)!.state).toEqual({ kind: 'skipped', note: 'Dentist then school' });

    let reply: any = await router.handle(click('unskipToday', run.id));
    expect(buttonsOf(reply)).toEqual(['Fill standup', '🏖️ Skip today']);
    // a card from before reasons were needed is redrawn so the next click asks why
    reply = await router.handle(click('skipToday', run.id));
    expect(buttonsOf(reply)).toEqual(['Fill standup', '🏖️ Skip today']);
    expect(reply.cardsV2[0].card.sections[0].widgets[1].buttonList.buttons[1].onClick.action).toMatchObject({ function: 'openSkipDialog', interaction: 'OPEN_DIALOG' });

    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    expect(status(await router.handle(skipWith(run.id, 'Ill'))).userFacingMessage).toBe('You already answered today. Edit your answers instead.');
    expect((await router.handle(click('skipToday', 999)) as any).text).toBe('This standup prompt is no longer valid.');
    expect((await router.handle(click('unskipToday', 999)) as any).text).toBe('This standup prompt is no longer valid.');

    const BOB = { name: 'users/bob', displayName: 'Bob', type: 'HUMAN' };
    await router.handle(skipWith(run.id, 'Travelling', BOB));
    clock.set('2026-06-10T12:00');
    await scheduler.tick();
    const closed: any = await router.handle(click('unskipToday', run.id, BOB));
    expect(closed.text).toBe("Today's Daily Standup has closed, so the skip stays.");
  });

  it('reports a skip that no longer matches anyone on the run', async () => {
    const { router, run } = await promptedRun();
    const stranger: any = await router.handle(skipWith(run.id, 'Lost', { name: 'users/zed', displayName: 'Zed', type: 'HUMAN' }));
    expect(status(stranger).userFacingMessage).toBe('This standup prompt is no longer valid.');
  });

  it('takes back skips by DM', async () => {
    const { router, run, service } = await promptedRun();
    const dm = (text: string) => router.handle({ type: 'MESSAGE', message: { text }, user: ALICE, space: { name: 'spaces/dm-alice', type: 'DM', spaceType: 'DIRECT_MESSAGE' } });
    expect(((await dm('unskip')) as any).text).toBe("Nothing to undo: you haven't skipped an open standup today.");
    await service.skipToday(run.id, 'users/alice', 'Dentist');
    expect(((await dm('unskip')) as any).text).toBe("↩️ Skip undone for Daily Standup — your prompt card is back, and you're expected today.");
    expect(((await dm('help')) as any).text).toContain('`unskip`');
  });
});

describe('tagging people on a blocker from Chat', () => {
  it('DMs the owner a card to pull people in, and tags whoever they pick', async () => {
    const { router, run, service, adapter, blockers } = await promptedRun();
    await service.submit(run.id, 'users/alice', 'Alice', withBlocker('Waiting on API keys'));
    const owner = adapter.dms.find((d) => d.kind === 'blockerCard' && d.owner)!;
    expect(owner).toMatchObject({ userName: 'users/alice', text: 'From your standup today. Tag people who can help, add updates, or resolve it.' });
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
          delete: async (params: any) => {
            calls.push({ method: 'delete', params });
            return { data: {} };
          },
        },
      },
    } as unknown as chat_v1.Chat;
    const gchat = new GoogleChatAdapter(repo, settings, () => client);
    expect(await gchat.sendStandupPrompt('users/alice', standup, run)).toBe('spaces/dm-alice/messages/1');
    expect(await gchat.sendReminder('users/alice', standup, run)).toBeNull();
    await gchat.updateStandupCards(['m/1', 'm/2'], standup, run, { kind: 'skipped', note: 'Dentist' });
    const updates = calls.filter((c) => c.method === 'update');
    expect(updates.map((u) => [u.params.name, u.params.updateMask])).toEqual([
      ['m/1', 'cardsV2'],
      ['m/2', 'cardsV2'],
    ]);
    expect(textOf(updates[0]!.params.requestBody)).toContain('You skipped today: <i>Dentist</i>');

    await gchat.postSkip(standup, run, 'Alice', 'Dentist');
    expect(calls.at(-1)!.params).toMatchObject({ parent: standup.spaceName, messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD', requestBody: { text: '🏖️ *Alice* is skipping today: Dentist', thread: { threadKey: run.threadKey } } });
    await gchat.deleteMessage('spaces/team/messages/9');
    expect(calls.at(-1)).toEqual({ method: 'delete', params: { name: 'spaces/team/messages/9' } });
  });
});
