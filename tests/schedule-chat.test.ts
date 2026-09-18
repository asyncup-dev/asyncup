import { describe, expect, it } from 'bun:test';
import { chat_v1 } from '@googleapis/chat';
import { GoogleChatAdapter } from '../src/adapters/gchat/adapter.js';
import { APPROVE_REQUEST_FN, DECLINE_REQUEST_FN, SUBMIT_DECLINE_FN, declineDialog, timeOffRequestCard } from '../src/adapters/gchat/cards.js';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const alice = { name: 'users/alice', displayName: 'Alice', type: 'HUMAN' };
const admin = { name: 'users/admin', displayName: 'Admin', type: 'HUMAN' };
const dm = (user: typeof alice, text: string) => ({ type: 'MESSAGE', space: { name: `spaces/dm-${user.name.slice(6)}`, type: 'DM' }, message: { argumentText: text }, user });
const spaceMsg = (text: string, mentions: { name: string; displayName: string }[] = [], user = admin) => ({
  type: 'MESSAGE',
  space: { name: 'spaces/team', type: 'ROOM' },
  message: { argumentText: text, annotations: mentions.map((m) => ({ type: 'USER_MENTION', userMention: { user: { ...m, type: 'HUMAN' } } })) },
  user,
});

async function setup() {
  const stack = await makeStack();
  const standup = await seedStandup(stack.repo);
  stack.clock.set('2026-06-10T10:00'); // Wednesday
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT, stack.polls, async () => null, stack.schedule);
  return { ...stack, standup, router };
}

describe('schedule DM commands', () => {
  it('marks days off, lists and cancels them, and sets the personal week', async () => {
    const { router, repo } = await setup();
    let reply: any = await router.handle(dm(alice, 'off tomorrow comp off'));
    expect(reply.text).toContain('Thu 11 Jun marked off (comp off)');
    reply = await router.handle(dm(alice, 'working 13 jun release'));
    expect(reply.text).toContain('marked *working* on Sat 13 Jun');
    reply = await router.handle(dm(alice, 'off list'));
    expect(reply.text).toBe('Coming up:\n• Thu 11 Jun · off (comp off)\n• Sat 13 Jun · working (release)');
    reply = await router.handle(dm(alice, 'off cancel tomorrow'));
    expect(reply.text).toContain('back to your usual week');
    reply = await router.handle(dm(alice, 'off cancel'));
    expect(reply.text).toContain('Say when');
    reply = await router.handle(dm(alice, 'days mon-thu'));
    expect(reply.text).toContain('Your week is now *Mon–Thu*');
    expect(await repo.getUserWorkingDays('users/alice')).toBe('mon,tue,wed,thu');
    reply = await router.handle(dm(alice, 'off'));
    expect(reply.text).toContain('Say when');
    reply = await router.handle(dm(alice, 'OFF LIST'));
    expect(reply.text).toContain('Sat 13 Jun · working');
  });

  it('explains the schedule commands in the DM help, and stays quiet without a schedule service', async () => {
    const { router, commands, service, blockers, repo } = await setup();
    const help: any = await router.handle(dm(alice, 'what?'));
    expect(help.text).toContain('`off <date|range> [reason]`');
    const bare = new EventRouter(commands, service, blockers, repo, TENANT);
    const reply: any = await bare.handle(dm(alice, 'off tomorrow'));
    expect(reply.text).not.toContain('marked off');
  });

  it('managers who DM their own days off are not blocked by a managers-only policy', async () => {
    const { router, repo, standup } = await setup();
    await repo.updateStandup(standup.id, { timeOffPolicy: 'managers' });
    await repo.upsertParticipant({ standupId: standup.id, userName: 'users/admin', displayName: 'Admin' });
    await repo.addAdmin(standup.id, 'users/admin', 'Admin');
    expect(((await router.handle(dm(alice, 'off tomorrow'))) as any).text).toContain('Only your managers');
    expect(((await router.handle(dm(admin, 'off tomorrow'))) as any).text).toContain('marked off');
  });

  it('nothing coming up reads as such', async () => {
    const { router } = await setup();
    expect(((await router.handle(dm(alice, 'off list'))) as any).text).toContain('Nothing coming up');
  });
});

describe('schedule space commands', () => {
  it('lets managers mark people away or working and set their week by mention', async () => {
    const { router, repo, standup, adapter } = await setup();
    await repo.addAdmin(standup.id, 'users/admin', 'Admin');
    let reply: any = await router.handle(spaceMsg('off @Alice tomorrow dentist', [{ name: 'users/alice', displayName: 'Alice' }]));
    expect(reply.text).toContain('Thu 11 Jun marked off (dentist)');
    expect(adapter.dms.at(-1)).toMatchObject({ userName: 'users/alice', text: expect.stringContaining('Admin marked you *away*') });
    reply = await router.handle(spaceMsg('working @Alice sat', [{ name: 'users/alice', displayName: 'Alice' }]));
    expect(reply.text).toContain('Alice is marked *working* on Sat 13 Jun');
    reply = await router.handle(spaceMsg('days @Alice tue-fri', [{ name: 'users/alice', displayName: 'Alice' }]));
    expect(reply.text).toContain("Alice's week is now *Tue–Fri*");
    reply = await router.handle(spaceMsg('off @Alice cancel tomorrow', [{ name: 'users/alice', displayName: 'Alice' }]));
    expect(reply.text).toContain("back to Alice's usual week");
    reply = await router.handle(spaceMsg('off tomorrow'));
    expect(reply.text).toBe('Mention the person, e.g. `off @Asha tomorrow comp off`.');
    reply = await router.handle(spaceMsg('working'));
    expect(reply.text).toBe('Mention the person, e.g. `working @Asha tomorrow`.');
    reply = await router.handle(spaceMsg('off @Alice', [{ name: 'users/alice', displayName: 'Alice' }]));
    expect(reply.text).toContain('Say when');
    reply = await router.handle(spaceMsg('off @Alice cancel xyz', [{ name: 'users/alice', displayName: 'Alice' }]));
    expect(reply.text).toContain('Say when');
    // days without a mention still configures the standup
    reply = await router.handle(spaceMsg('days mon,tue'));
    expect(reply.text).toContain('Standup runs on: mon, tue');
    // non-admins are refused like any other configuration command
    reply = await router.handle(spaceMsg('off @Alice tomorrow', [{ name: 'users/alice', displayName: 'Alice' }], alice));
    expect(reply.text).toContain('Only admins');
  });

  it('reports when schedules are not wired in', async () => {
    const { repo, settings, blockers, adapter, polls, service, clock, standup } = await setup();
    const { CommandHandler } = await import('../src/core/commands.js');
    const commands = new CommandHandler(repo, settings, clock.now, blockers, adapter, polls);
    const router = new EventRouter(commands, service, blockers, repo, TENANT, polls);
    await repo.addAdmin(standup.id, 'users/admin', 'Admin');
    for (const text of ['off @Alice tomorrow', 'days @Alice mon']) {
      const reply: any = await router.handle(spaceMsg(text, [{ name: 'users/alice', displayName: 'Alice' }]));
      expect(reply.text).toBe('Personal schedules are not available on this install.');
    }
  });

  it('lists the commands in help', async () => {
    const { router } = await setup();
    const reply: any = await router.handle(spaceMsg('help all'));
    expect(reply.text).toContain('`off @user <date|range> [reason]`');
    expect(reply.text).toContain('`days @user mon-thu|adhoc|reset`');
  });
});

describe('time-off request cards', () => {
  it('builds the manager card with both buttons carrying the request ids', () => {
    const standup = { id: 1, name: 'Engineering' } as any;
    const card: any = timeOffRequestCard({ ids: [7, 8], person: { userName: 'users/alice', displayName: 'Alice' }, dates: ['2026-06-22', '2026-06-23'], working: false, reason: 'sick', standup });
    const c = card.cardsV2[0].card;
    expect(c.header).toEqual({ title: 'Time-off request · Engineering', subtitle: 'Alice · Mon 22 Jun – Tue 23 Jun · 2 days off' });
    expect(c.sections[0].widgets[0].textParagraph.text).toContain('“sick” Approve and Alice is marked away');
    const buttons = c.sections[0].widgets[1].buttonList.buttons;
    expect(buttons[0].onClick.action).toEqual({ function: APPROVE_REQUEST_FN, parameters: [{ key: 'requestIds', value: '7,8' }] });
    expect(buttons[1].onClick.action).toMatchObject({ function: DECLINE_REQUEST_FN, interaction: 'OPEN_DIALOG' });
    const working: any = timeOffRequestCard({ ids: [9], person: { userName: 'users/bob', displayName: 'Bob' }, dates: ['2026-06-13'], working: true, reason: '', standup }, 'https://x.example/chat/events');
    expect(working.cardsV2[0].card.header.title).toBe('Working day request · Engineering');
    expect(working.cardsV2[0].card.header.subtitle).toBe('Bob · Sat 13 Jun · 1 day working');
    expect(working.cardsV2[0].card.sections[0].widgets[1].buttonList.buttons[0].onClick.action.function).toBe('https://x.example/chat/events');
    const dialog: any = declineDialog('9');
    expect(dialog.actionResponse.dialogAction.dialog.body.sections[0].widgets[1].buttonList.buttons[0].onClick.action).toEqual({ function: SUBMIT_DECLINE_FN, parameters: [{ key: 'requestIds', value: '9' }] });
  });

  it('approves and declines from the card, and ignores the buttons without a schedule service', async () => {
    const { router, repo, standup, adapter, commands, service, blockers } = await setup();
    await repo.updateStandup(standup.id, { timeOffPolicy: 'approval' });
    await repo.addAdmin(standup.id, 'users/admin', 'Admin');
    await router.handle(dm(alice, 'off 22 jun to 23 jun sick'));
    const request = adapter.dms.find((d) => d.kind === 'timeOffRequest')!.request!;
    const click = (fn: string, user = admin, extra: object = {}) => ({
      type: 'CARD_CLICKED',
      common: { invokedFunction: fn, parameters: { requestIds: request.ids.join(',') }, ...extra },
      user,
      space: { name: 'spaces/dm-admin', spaceType: 'DIRECT_MESSAGE' },
    });
    const dialog: any = await router.handle(click(DECLINE_REQUEST_FN));
    expect(dialog.actionResponse.type).toBe('DIALOG');
    const declined: any = await router.handle({ ...click(SUBMIT_DECLINE_FN), isDialogEvent: true, common: { invokedFunction: SUBMIT_DECLINE_FN, parameters: { requestIds: request.ids.join(',') }, formInputs: { note: { stringInputs: { value: ['  not now  '] } } } } });
    expect(declined.actionResponse.dialogAction.actionStatus).toEqual({ statusCode: 'OK', userFacingMessage: '❌ Declined — Alice has been told.' });
    expect((await repo.getOverride('users/alice', '2026-06-22'))!).toMatchObject({ status: 'declined', decisionNote: 'not now' });
    const again: any = await router.handle({ ...click(SUBMIT_DECLINE_FN), isDialogEvent: true });
    expect(again.actionResponse.dialogAction.actionStatus.statusCode).toBe('INVALID_ARGUMENT');

    await router.handle(dm(alice, 'off 24 jun'));
    const second = adapter.dms.filter((d) => d.kind === 'timeOffRequest').at(-1)!.request!;
    const approved: any = await router.handle({ ...click(APPROVE_REQUEST_FN), common: { invokedFunction: APPROVE_REQUEST_FN, parameters: { requestIds: second.ids.join(',') } } });
    expect(approved.text).toBe('✅ Approved — Alice has been told.');
    const refused: any = await router.handle({ ...click(APPROVE_REQUEST_FN, alice), common: { invokedFunction: APPROVE_REQUEST_FN, parameters: { requestIds: 'abc' } } });
    expect(refused.text).toContain('already decided');

    const bare = new EventRouter(commands, service, blockers, repo, TENANT);
    expect(await bare.handle(click(APPROVE_REQUEST_FN))).toEqual({});
  });
});

describe('GoogleChatAdapter.sendTimeOffRequest', () => {
  it('DMs the manager the card addressed to the events URL', async () => {
    const { repo, settings } = await makeStack();
    await settings.update({ chatAudience: '742900314218 https://standup.example.com/chat/events' });
    const calls: any[] = [];
    const client = {
      spaces: {
        findDirectMessage: async () => ({ data: { name: 'spaces/dm-admin' } }),
        messages: { create: async (params: any) => { calls.push(params); return { data: { name: 'spaces/dm-admin/messages/1' } }; } },
      },
    } as unknown as chat_v1.Chat;
    const gchat = new GoogleChatAdapter(repo, settings, () => client);
    await gchat.sendTimeOffRequest('users/admin', { ids: [1], person: { userName: 'users/alice', displayName: 'Alice' }, dates: ['2026-06-22'], working: false, reason: '', standup: { id: 1, name: 'Eng' } as any });
    expect(calls[0].parent).toBe('spaces/dm-admin');
    expect(calls[0].requestBody.cardsV2[0].card.sections[0].widgets[1].buttonList.buttons[0].onClick.action.function).toBe('https://standup.example.com/chat/events');
  });
});

describe('schedule webhooks', () => {
  it('POSTs schedule_change and time_off_request events', async () => {
    const calls: { body: any }[] = [];
    const stack = await makeStack({ webhookFetch: (async (_url: any, init: any) => { calls.push({ body: JSON.parse(init.body) }); return new Response('', { status: 200 }); }) as typeof fetch });
    const standup = await seedStandup(stack.repo);
    stack.clock.set('2026-06-10T10:00');
    await stack.repo.updateStandup(standup.id, { webhookUrl: 'https://hooks.example/asyncup' });
    await stack.schedule.setOverride({ target: { userName: 'users/alice', displayName: 'Alice' }, dates: ['2026-06-12'], working: false, reason: 'comp off', actor: { userName: 'users/alice', displayName: 'Alice', self: true, manager: false }, channel: 'chat' });
    await stack.repo.updateStandup(standup.id, { timeOffPolicy: 'approval' });
    await stack.schedule.setOverride({ target: { userName: 'users/bob', displayName: 'Bob' }, dates: ['2026-06-15'], working: true, reason: '', actor: { userName: 'users/bob', displayName: 'Bob', self: true, manager: false }, channel: 'console' });
    expect(calls.map((c) => c.body.event)).toEqual(['schedule_change', 'time_off_request']);
    expect(calls[0]!.body).toMatchObject({ standup: { id: standup.id, name: 'Daily Standup' }, person: { userName: 'users/alice' }, summary: 'Alice is off Fri 12 Jun (comp off)', by: 'Alice', channel: 'chat' });
    expect(calls[1]!.body).toMatchObject({ person: { userName: 'users/bob' }, dates: ['2026-06-15'], working: true, reason: '', requestIds: [expect.any(Number)] });
  });
});
