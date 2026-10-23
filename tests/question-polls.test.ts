import { describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { OPEN_POLL_FORM_FN, SUBMIT_POLL_FORM_FN, pollCardMessage, pollFormDialog, pollSummaryMessage } from '../src/adapters/gchat/cards.js';
import type { PollDraft } from '../src/core/question-polls.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const asha = { userName: 'users/admin', displayName: 'Asha' };
const alice = { userName: 'users/alice', displayName: 'Alice' };
const bob = { userName: 'users/bob', displayName: 'Bob' };

const DRAFT: PollDraft = {
  title: 'Release retro',
  intro: 'Two minutes, please.',
  questions: [
    { text: 'What went well?', type: 'long', required: true, options: [] },
    { text: 'Which day suits the retro?', type: 'single', required: true, options: ['Monday', 'Tuesday', 'Wednesday'] },
    { text: 'What should we change?', type: 'multiple', required: false, options: ['Smaller PRs', 'Earlier freeze'] },
    { text: 'Lunch?', type: 'dropdown', required: false, options: ['Pizza', 'Salad'] },
    { text: 'One word for it', type: 'short', required: false, options: [] },
  ],
  closesAt: '2026-06-10T17:00',
  remindMinutes: 60,
  anonymous: false,
  results: 'everyone',
};

async function stack(opts: Parameters<typeof makeStack>[0] = {}) {
  const s = await makeStack(opts);
  const standup = await seedStandup(s.repo); // Alice, Bob, Carol (optional)
  await s.repo.addAdmin(standup.id, asha.userName, asha.displayName);
  s.clock.set('2026-06-10T10:00');
  const router = new EventRouter(s.commands, s.service, s.blockers, s.repo, TENANT, s.polls, async () => null, s.schedule);
  const polls = s.service.questionPolls;
  const send = async (draft: Partial<PollDraft> = {}) => {
    const r = await polls.create(standup, { ...DRAFT, ...draft }, asha);
    if (!r.ok) throw new Error(r.message);
    return r.poll;
  };
  const click = (fn: string, user: typeof alice, params: Record<string, string>, formInputs: Record<string, string[]> = {}) =>
    router.handle({
      type: 'CARD_CLICKED',
      isDialogEvent: fn === SUBMIT_POLL_FORM_FN,
      user: { name: user.userName, displayName: user.displayName, type: 'HUMAN' },
      space: { name: 'spaces/dm', type: 'DM' },
      common: { invokedFunction: fn, parameters: params, formInputs: Object.fromEntries(Object.entries(formInputs).map(([k, v]) => [k, { stringInputs: { value: v } }])) },
    }) as Promise<any>;
  return { ...s, standup, router, polls, send, click };
}

describe('creating a poll', () => {
  it('checks the draft before anything is stored (criteria 1–5)', async () => {
    const { polls, standup, repo } = await stack();
    const bad = async (draft: Partial<PollDraft>) => {
      const r = await polls.create(standup, { ...DRAFT, ...draft }, asha);
      return r.ok ? 'ok' : `${r.field}: ${r.message}`;
    };
    expect(await bad({ title: ' ' })).toBe('title: Give the poll a title.');
    expect(await bad({ title: 'x'.repeat(101) })).toBe('title: Keep the title to 100 characters.');
    expect(await bad({ intro: 'x'.repeat(501) })).toBe('intro: Keep the intro to 500 characters.');
    expect(await bad({ questions: [] })).toBe('questions: Add 1 to 10 questions.');
    expect(await bad({ questions: Array(11).fill(DRAFT.questions[0]) })).toBe('questions: Add 1 to 10 questions.');
    expect(await bad({ questions: [{ text: '', type: 'short', required: true, options: [] }] })).toBe('questions.0: Question 1 needs its text, up to 200 characters.');
    expect(await bad({ questions: [{ text: 'Pick', type: 'single', required: true, options: ['Only one'] }] })).toBe('questions.0: Question 1 needs 2 to 20 options.');
    expect(await bad({ questions: [{ text: 'Pick', type: 'dropdown', required: true, options: ['A', 'a'] }] })).toBe('questions.0: Question 1 has the option “a” twice.');
    expect(await bad({ questions: [{ text: 'Pick', type: 'multiple', required: true, options: ['A', 'x'.repeat(81)] }] })).toBe('questions.0: Keep each option to 80 characters.');
    expect(await bad({ questions: [{ text: 'Pick', type: 'nope' as any, required: true, options: [] }] })).toBe('questions.0: Question 1 has an unknown type.');
    expect(await bad({ closesAt: '2026-06-10T10:10' })).toBe('closesAt: Close it between 15 minutes and 14 days from now.');
    expect(await bad({ closesAt: '2026-06-25T10:00' })).toBe('closesAt: Close it between 15 minutes and 14 days from now.');
    expect(await bad({ closesAt: 'soon' })).toBe('closesAt: Close it between 15 minutes and 14 days from now.');
    expect(await bad({ remindMinutes: 30 })).toBe('remindMinutes: Remind 15 minutes, 1 hour or 1 day before, or not at all.');
    expect(await bad({ closesAt: '2026-06-10T10:30', remindMinutes: 60 })).toBe('remindMinutes: That reminder would be in the past. Choose a shorter one, or none.');
    expect(await bad({ results: 'live' as any })).toBe('results: Results go to everyone after it closes, or to managers only.');
    expect(await polls.list(standup.id)).toEqual([]);
    expect(await repo.listQuestionPolls(standup.id)).toEqual([]);
  });

  it('asks everyone active on the roster except people on vacation, by DM, with a summary in the space (criteria 6, 7, 10)', async () => {
    const { send, adapter, repo, standup } = await stack();
    await repo.setParticipantVacation(standup.id, 'users/carol', true);
    const poll = await send();
    expect(adapter.pollCards.map((c) => [c.userName, c.state.kind])).toEqual([['users/alice', 'open'], ['users/bob', 'open']]);
    expect(adapter.pollCards[0]!.view).toMatchObject({ title: 'Release retro', from: 'Asha', closesLabel: 'Wed 10 Jun, 17:00 Asia/Kolkata', questions: DRAFT.questions });
    const summary = adapter.posts.find((p) => p.kind === 'pollSummary')!;
    expect(summary).toMatchObject({ spaceName: 'spaces/team', threadKey: `qpoll-${poll.id}`, counts: { asked: 2, answered: 0 }, closed: false });
    expect(await repo.getQuestionPoll(poll.id)).toMatchObject({ closesAt: '2026-06-10T11:30:00.000Z', remindAt: '2026-06-10T10:30:00.000Z' });
  });

  it('still sends to everyone else when Chat refuses one DM, and logs it', async () => {
    const { send, adapter } = await stack();
    const original = adapter.sendPollCard.bind(adapter);
    adapter.sendPollCard = async (userName, view, state) => {
      if (userName === 'users/alice') throw new Error('no DM space');
      return original(userName, view, state);
    };
    await send();
    expect(adapter.pollCards.map((c) => c.userName)).toEqual(['users/bob', 'users/carol']);
  });

  it('refuses a poll nobody on the roster can be asked', async () => {
    const { polls, repo, standup } = await stack();
    for (const p of await repo.listParticipants(standup.id)) await repo.setParticipantVacation(standup.id, p.userName, true);
    expect(await polls.create(standup, DRAFT, asha)).toEqual({ ok: false, field: 'standupId', message: 'Nobody on Daily Standup can be asked: everyone is on vacation or the roster is empty.' });
  });
});

describe('answering in Chat', () => {
  it('opens the form with every question, refuses a missing required answer and keeps what was entered (criterion 8)', async () => {
    const { send, click } = await stack();
    const poll = await send();
    const form = await click(OPEN_POLL_FORM_FN, alice, { pollId: String(poll.id) });
    const widgets = form.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    expect(widgets.map((w: any) => w.textInput?.label ?? w.selectionInput?.label ?? null).filter(Boolean)).toEqual([
      'What went well? (required)',
      'Which day suits the retro? (required)',
      'What should we change?',
      'Lunch?',
      'One word for it',
    ]);
    expect(widgets.find((w: any) => w.selectionInput?.name === 'q1').selectionInput.type).toBe('RADIO_BUTTON');
    expect(widgets.find((w: any) => w.selectionInput?.name === 'q2').selectionInput.type).toBe('CHECK_BOX');
    expect(widgets.find((w: any) => w.selectionInput?.name === 'q3').selectionInput.items[0]).toEqual({ text: 'Choose one', value: '', selected: true });
    expect(widgets.find((w: any) => w.textInput?.name === 'q0').textInput.type).toBe('MULTIPLE_LINE');

    const missing = await click(SUBMIT_POLL_FORM_FN, alice, { pollId: String(poll.id) }, { q0: ['The rollout'], q2: ['1'] });
    const again = missing.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    expect(JSON.stringify(again[0])).toContain('Answer “Which day suits the retro?”');
    expect(again.find((w: any) => w.textInput?.name === 'q0').textInput.value).toBe('The rollout');
    expect(again.find((w: any) => w.selectionInput?.name === 'q2').selectionInput.items.map((i: any) => i.selected)).toEqual([false, true]);
  });

  it('records answers, redraws the person’s card and lets them change answers until the close (criteria 9, 10)', async () => {
    const { send, click, adapter, polls, clock } = await stack();
    const poll = await send();
    clock.set('2026-06-10T14:02');
    let reply = await click(SUBMIT_POLL_FORM_FN, alice, { pollId: String(poll.id) }, { q0: ['The rollout'], q1: ['0'], q2: ['0', '1'], q3: ['1'], q4: ['Smooth'] });
    expect(reply.actionResponse.dialogAction.actionStatus).toEqual({ statusCode: 'OK', userFacingMessage: '✅ Answered. You can change your answers until 17:00 Asia/Kolkata.' });
    expect(adapter.pollCardUpdates.at(-1)).toMatchObject({ messageNames: [expect.any(String)], state: { kind: 'answered', at: expect.stringContaining('08:32') } });
    expect((await polls.form(poll.id, alice.userName))).toMatchObject({ ok: true, answers: ['The rollout', [0], [0, 1], [1], 'Smooth'] });
    // Change answers: the form comes back filled in, and the new answers replace the old.
    const form = await click(OPEN_POLL_FORM_FN, alice, { pollId: String(poll.id) });
    const widgets = form.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    expect(widgets.find((w: any) => w.textInput?.name === 'q0').textInput.value).toBe('The rollout');
    expect(widgets.find((w: any) => w.selectionInput?.name === 'q1').selectionInput.items.map((i: any) => i.selected)).toEqual([true, false, false]);
    reply = await click(SUBMIT_POLL_FORM_FN, alice, { pollId: String(poll.id) }, { q0: ['Pairing'], q1: ['2'] });
    expect(reply.actionResponse.dialogAction.actionStatus.statusCode).toBe('OK');
    expect((await polls.form(poll.id, alice.userName))).toMatchObject({ ok: true, answers: ['Pairing', [2], [], null, null] });
  });

  it('refuses people not asked, bad options and over-long text', async () => {
    const { send, click, polls } = await stack();
    const poll = await send();
    expect((await click(OPEN_POLL_FORM_FN, { userName: 'users/zed', displayName: 'Zed' }, { pollId: String(poll.id) })).actionResponse.dialogAction.actionStatus.userFacingMessage).toBe('This poll wasn’t sent to you.');
    expect((await click(OPEN_POLL_FORM_FN, alice, { pollId: '999' })).actionResponse.dialogAction.actionStatus.userFacingMessage).toBe('This poll no longer exists.');
    expect(await polls.answer(poll.id, alice, ['ok', [7], [], null, null])).toEqual({ ok: false, message: 'That option no longer exists.' });
    expect(await polls.answer(poll.id, alice, ['x'.repeat(1001), [0], [], null, null])).toEqual({ ok: false, message: 'Keep “What went well?” to 1,000 characters.' });
    expect(await polls.answer(poll.id, alice, ['ok', [0], [], null, 'x'.repeat(201)])).toEqual({ ok: false, message: 'Keep “One word for it” to 200 characters.' });
    expect(await polls.answer(poll.id, alice, ['ok', [0, 1], [], null, null])).toEqual({ ok: false, message: 'Pick one answer for “Which day suits the retro?”.' });
  });
});

describe('the timer', () => {
  it('reminds once, only people who haven’t answered, before the close (criterion 11)', async () => {
    const { send, polls, scheduler, clock, adapter } = await stack();
    const poll = await send();
    await polls.answer(poll.id, bob, ['Fine', [1], [], null, null]);
    clock.set('2026-06-10T16:00');
    await scheduler.tick();
    await scheduler.tick();
    expect(adapter.pollCards.filter((c) => c.state.kind === 'reminder').map((c) => c.userName)).toEqual(['users/alice', 'users/carol']);
  });

  it('closes at the close time, refuses late answers, redraws every card and posts results (criteria 12, 14, 15)', async () => {
    const { send, click, polls, scheduler, clock, adapter, repo } = await stack();
    const poll = await send();
    await polls.answer(poll.id, alice, ['The rollout', [0], [0], null, null]);
    await polls.answer(poll.id, bob, ['Pairing', [0], [0, 1], [1], null]);
    clock.set('2026-06-10T17:00');
    await scheduler.tick();
    await scheduler.tick();
    expect((await repo.getQuestionPoll(poll.id))!.closedAt).toBe('2026-06-10T11:30:00.000Z');
    const late = await click(SUBMIT_POLL_FORM_FN, alice, { pollId: String(poll.id) }, { q0: ['Late'], q1: ['1'] });
    expect(late.actionResponse.dialogAction.actionStatus.userFacingMessage).toBe('This poll closed at 17:00 Asia/Kolkata.');
    expect(adapter.pollCardUpdates.filter((u) => u.state.kind === 'closed')).toHaveLength(3);
    expect(adapter.pollSummaryUpdates.at(-1)).toMatchObject({ counts: { asked: 3, answered: 2 }, closed: true });
    const results = adapter.posts.filter((p) => p.kind === 'text' && p.threadKey === `qpoll-${poll.id}`);
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe(
      '📊 *Release retro*: 2 of 3 answered\n\n' +
        '*Which day suits the retro?*\nMonday: *2* — Alice, Bob\nTuesday: *0*\nWednesday: *0*\n\n' +
        '*What should we change?*\nSmaller PRs: *2* — Alice, Bob\nEarlier freeze: *1* — Bob\n\n' +
        '*Lunch?*\nPizza: *0*\nSalad: *1* — Bob\n\n' +
        '*What went well?* 2 answers\n*One word for it* 0 answers\n\nText answers are in the web app, under Daily Standup › Polls.',
    );
  });

  it('posts only a count when results are for managers, and never names on an anonymous poll (criteria 15, 17)', async () => {
    const { send, polls, adapter } = await stack();
    const managers = await send({ results: 'managers' });
    await polls.answer(managers.id, alice, ['ok', [0], [], null, null]);
    expect(await polls.close(managers.id, asha)).toBe('closed');
    expect(adapter.posts.at(-1)!.text).toBe('📊 *Release retro* closed: 1 of 3 answered. Results are with the standup’s managers.');
    const anon = await send({ anonymous: true });
    await polls.answer(anon.id, alice, ['ok', [0], [], null, null]);
    await polls.close(anon.id, asha);
    expect(adapter.posts.at(-1)!.text).toContain('Monday: *1*\n');
    expect(adapter.posts.at(-1)!.text).not.toContain('Alice');
  });

  it('closes early once, from a manager (criteria 13, 14)', async () => {
    const { send, polls } = await stack();
    const poll = await send();
    expect(await polls.close(poll.id, asha)).toBe('closed');
    expect(await polls.close(poll.id, asha)).toBe('already_closed');
    expect(await polls.close(999, asha)).toBe('not_found');
  });

  it('redraws the space count at most once a minute (criterion 7)', async () => {
    const { send, polls, scheduler, clock, adapter } = await stack();
    const poll = await send();
    await polls.answer(poll.id, alice, ['ok', [0], [], null, null]);
    clock.set('2026-06-10T10:00:30');
    await scheduler.tick();
    expect(adapter.pollSummaryUpdates).toHaveLength(0);
    clock.set('2026-06-10T10:01:05');
    await scheduler.tick();
    await scheduler.tick();
    expect(adapter.pollSummaryUpdates.map((u) => u.counts)).toEqual([{ asked: 3, answered: 1 }]);
  });

  it('sends a poll_closed webhook, with names only for a named poll (criterion 20)', async () => {
    const bodies: any[] = [];
    const webhookFetch = (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), new Response('ok'))) as unknown as typeof fetch;
    const { send, polls, repo, standup } = await stack({ webhookFetch });
    await repo.updateStandup(standup.id, { webhookUrl: 'https://hooks.example.com/x' });
    for (const anonymous of [false, true]) {
      const poll = await send({ anonymous });
      await polls.answer(poll.id, alice, ['ok', [0], [], null, null]);
      await polls.close(poll.id, asha);
    }
    const closed = bodies.filter((b) => b.event === 'poll_closed');
    expect(closed.map((b) => [b.poll.anonymous, b.poll.answered, b.poll.questions[1].options[0]])).toEqual([
      [false, 1, { text: 'Monday', count: 1, names: ['Alice'] }],
      [true, 1, { text: 'Monday', count: 1, names: null }],
    ]);
  });
});

describe('the polls command', () => {
  it('lists open polls with questions beside quick polls', async () => {
    const { send, router, polls } = await stack();
    const inSpace = (text: string) => router.handle({ type: 'MESSAGE', space: { name: 'spaces/team', type: 'ROOM' }, message: { argumentText: text }, user: { name: asha.userName, displayName: asha.displayName, type: 'HUMAN' } }) as Promise<any>;
    const poll = await send();
    await polls.answer(poll.id, alice, ['ok', [0], [], null, null]);
    expect((await inSpace('polls')).text).toBe('*Polls with questions:*\n📋 Release retro — 1 of 3 answered, closes Wed 10 Jun, 17:00 Asia/Kolkata (by Asha)\nResults are in the web app, under Daily Standup › Polls.');
    await inSpace('poll Deploy? | Yes | No');
    expect((await inSpace('polls')).text).toMatch(/^\*Open polls:\*\n#1 Deploy\? — 0 votes \(by Asha\)\n`poll <id> results` · `poll <id> close`\n\n\*Polls with questions:\*/);
    await polls.close(poll.id, asha);
    expect((await inSpace('polls')).text).not.toContain('Polls with questions');
  });
});

describe('poll cards', () => {
  const view = { id: 4, standupId: 1, standupName: 'Daily Standup', title: 'Release retro', intro: 'Two <b>minutes</b>', from: 'Asha', questions: DRAFT.questions, closesLabel: 'Wed 10 Jun, 17:00 Asia/Kolkata', closesTime: '17:00 Asia/Kolkata', anonymous: false, results: 'everyone' as const, zone: 'Asia/Kolkata' };
  const text = (m: any) => JSON.stringify(m);

  it('draws the DM card for each state, escaping what people typed', () => {
    expect(text(pollCardMessage(view, { kind: 'open' }))).toContain('Two &lt;b&gt;minutes&lt;/b&gt;');
    expect(text(pollCardMessage(view, { kind: 'open' }))).toContain('5 questions · closes <b>Wed 10 Jun, 17:00 Asia/Kolkata</b>');
    expect(text(pollCardMessage(view, { kind: 'open' }))).toContain('"text":"Respond"');
    expect(text(pollCardMessage(view, { kind: 'reminder' }))).toContain('You haven’t answered yet');
    expect(text(pollCardMessage(view, { kind: 'answered', at: '2026-06-10T08:32:00.000Z' }))).toContain('✅ Answered at <b>14:02</b>. You can change your answers until <b>17:00 Asia/Kolkata</b>.');
    expect(text(pollCardMessage(view, { kind: 'answered', at: '2026-06-10T08:32:00.000Z' }))).toContain('"text":"Change answers"');
    const closed = text(pollCardMessage(view, { kind: 'closed', answeredAt: null }));
    expect(closed).toContain('🔒 Closed at 17:00 Asia/Kolkata.');
    expect(closed).not.toContain('Respond');
    expect(text(pollCardMessage({ ...view, anonymous: true }, { kind: 'open' }))).toContain('Anonymous: nobody sees who answered what.');
  });

  it('draws the space summary open and closed', () => {
    expect(text(pollSummaryMessage(view, { asked: 8, answered: 3 }, false))).toContain('3 of 8 answered · closes Wed 10 Jun, 17:00 Asia/Kolkata');
    expect(text(pollSummaryMessage({ ...view, results: 'managers' }, { asked: 8, answered: 3 }, false))).toContain('Results go to the standup’s managers.');
    expect(text(pollSummaryMessage(view, { asked: 8, answered: 7 }, true))).toContain('🔒 Closed: 7 of 8 answered. Results are in the thread.');
  });

  it('builds the form for every question type', () => {
    const d = pollFormDialog(view, [null, null, null, null, null]);
    const widgets = d.actionResponse.dialogAction.dialog.body.sections[0]!.widgets as any[];
    expect(widgets[0].textParagraph.text).toContain('Two &lt;b&gt;minutes&lt;/b&gt;');
    expect(widgets.find((w) => w.textInput?.name === 'q4').textInput.type).toBe('SINGLE_LINE');
  });
});
