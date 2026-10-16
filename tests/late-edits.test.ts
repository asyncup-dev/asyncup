import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  APPROVE_EDIT_FN,
  DECLINE_EDIT_FN,
  editApprovedCard,
  editRequestCard,
  editRequestDialog,
  OPEN_DIALOG_FN,
  OPEN_EDIT_REQUEST_FN,
  promptMessage,
  submissionMessage,
  SUBMIT_EDIT_DECLINE_FN,
  SUBMIT_EDIT_REQUEST_FN,
} from '../src/adapters/gchat/cards.js';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { createServer } from '../src/server.js';
import { ANSWERS, makeStack, seedStandup, TENANT } from './helpers.js';

const alice = { name: 'users/alice', displayName: 'Alice', type: 'HUMAN' };
const bob = { name: 'users/bob', displayName: 'Bob', type: 'HUMAN' };
const lead = { name: 'users/lead', displayName: 'Lead', type: 'HUMAN' };
const mgr = { name: 'users/mgr', displayName: 'Manager', type: 'HUMAN' };

const click = (fn: string, parameters: Record<string, string>, user = alice, formInputs?: Record<string, string>) => ({
  type: 'CARD_CLICKED',
  ...(formInputs ? { isDialogEvent: true } : {}),
  common: {
    invokedFunction: fn,
    parameters,
    ...(formInputs ? { formInputs: Object.fromEntries(Object.entries(formInputs).map(([k, v]) => [k, { stringInputs: { value: [v] } }])) } : {}),
  },
  user,
  space: { name: `spaces/dm-${user.name.slice(6)}`, spaceType: 'DIRECT_MESSAGE' },
});
const status = (reply: any) => reply.actionResponse.dialogAction.actionStatus;
const dialogText = (reply: any) => JSON.stringify(reply.actionResponse.dialogAction.dialog);

/** A run Alice answered on time, closed at the 11:30 deadline; Lead and Manager manage the standup. */
async function setup(opts: { webhookFetch?: typeof fetch } = {}) {
  const stack = await makeStack(opts);
  const standup = await seedStandup(stack.repo);
  await stack.repo.addAdmin(standup.id, 'users/lead', 'Lead');
  await stack.repo.addAdmin(standup.id, 'users/mgr', 'Manager');
  stack.clock.set('2026-06-10T09:30'); // Wednesday
  await stack.scheduler.tick();
  const run = (await stack.repo.getRun(standup.id, '2026-06-10'))!;
  stack.clock.set('2026-06-10T10:00');
  await stack.service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
  stack.clock.set('2026-06-10T11:31');
  await stack.scheduler.tick();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT, stack.polls, async () => null, stack.schedule);
  const ask = (reason = 'Wrong ticket number under Today') => router.handle(click(SUBMIT_EDIT_REQUEST_FN, { runId: String(run.id) }, alice, { reason }));
  return { ...stack, standup, run, router, ask };
}

describe('late first answers', () => {
  it('post without approval until midnight, then the day closes (criteria 1 and 2)', async () => {
    const { service, run, router, clock, adapter } = await setup();
    clock.set('2026-06-10T15:00');
    expect(await service.submit(run.id, 'users/bob', 'Bob', ANSWERS)).toEqual({ ok: true, late: true, edited: false });
    expect(adapter.dms.filter((d) => d.kind === 'editRequest')).toEqual([]);

    clock.set('2026-06-11T00:00');
    expect(await service.submit(run.id, 'users/carol', 'Carol', ANSWERS)).toEqual({ ok: false, reason: 'day_closed' });
    const closed = 'This standup has closed. Answers for Wed 10 Jun can no longer be added.';
    expect(status(await router.handle(click(OPEN_DIALOG_FN, { runId: String(run.id) }, { name: 'users/carol', displayName: 'Carol', type: 'HUMAN' })))).toEqual({ statusCode: 'INVALID_ARGUMENT', userFacingMessage: closed });
    const submit: any = await router.handle({ ...click('submitStandup', { runId: String(run.id) }, { name: 'users/carol', displayName: 'Carol', type: 'HUMAN' }, { q0: 'a', q1: 'b', q2: 'none', mood: 'good' }) });
    expect(status(submit)).toEqual({ statusCode: 'INVALID_ARGUMENT', userFacingMessage: closed });
  });
});

describe('asking to edit after the deadline', () => {
  it('redraws the prompt card of everyone who answered when the run closes (criterion 3)', async () => {
    const { adapter, run, standup, repo } = await setup();
    const names = await repo.listCardMessages(run.id, 'users/alice');
    expect(adapter.cardUpdates.at(-1)).toEqual({ messageNames: names, runId: run.id, state: { kind: 'submitted', at: expect.any(String), late: false, closed: true, edit: null } });
    // Bob never answered, so his card is left as it was.
    const bobs = await repo.listCardMessages(run.id, 'users/bob');
    expect(adapter.cardUpdates.some((u) => u.messageNames.includes(bobs[0]!))).toBe(false);
    const card = JSON.stringify(promptMessage(standup, run, null, { kind: 'submitted', at: '2026-06-10T10:00:00.000+05:30', late: false, closed: true, edit: null }));
    expect(card).toContain('✅ Submitted at <b>10:00</b>. The deadline has passed. Need to change something? Ask a manager.');
    expect(card).toContain(`"text":"Ask to edit","onClick":{"action":{"function":"${OPEN_EDIT_REQUEST_FN}","interaction":"OPEN_DIALOG"`);
  });

  it('opens the request dialog from Ask to edit, or from an Edit answers button drawn before the deadline (criterion 4)', async () => {
    const { router, run } = await setup();
    for (const fn of [OPEN_EDIT_REQUEST_FN, OPEN_DIALOG_FN]) {
      const reply: any = await router.handle(click(fn, { runId: String(run.id) }));
      expect(dialogText(reply)).toContain('"name":"reason"');
      expect(dialogText(reply)).toContain(SUBMIT_EDIT_REQUEST_FN);
    }
    const long: any = await router.handle(click(SUBMIT_EDIT_REQUEST_FN, { runId: String(run.id) }, alice, { reason: 'x'.repeat(201) }));
    expect(dialogText(long)).toContain('Keep it to 200 characters.');
    expect(dialogText(long)).toContain('x'.repeat(201));
  });

  it('sends every manager a card and tells the person (criterion 5)', async () => {
    const { ask, adapter, repo, run } = await setup();
    expect(status(await ask())).toEqual({ statusCode: 'OK', userFacingMessage: '📨 Sent to your managers. You’ll hear back here.' });
    const cards = adapter.dms.filter((d) => d.kind === 'editRequest');
    expect(cards.map((d) => d.userName)).toEqual(['users/lead', 'users/mgr']);
    expect(cards[0]!.editRequest).toMatchObject({ status: 'pending', reason: 'Wrong ticket number under Today', person: { userName: 'users/alice', displayName: 'Alice' }, date: '2026-06-10', until: '23:59 Asia/Kolkata' });
    const request = (await repo.getEditRequestFor(run.id, 'users/alice'))!;
    expect(request).toMatchObject({ status: 'pending', reason: 'Wrong ticket number under Today', cardMessages: [expect.any(String), expect.any(String)] });
    expect(adapter.cardUpdates.at(-1)!.state).toMatchObject({ kind: 'submitted', closed: true, edit: { status: 'pending', by: null, until: '23:59 Asia/Kolkata' } });
  });

  it('leaves the reason out when none is given, and skips a manager who is the one asking', async () => {
    const { service, adapter, repo, run, standup } = await setup();
    await service.submit(run.id, 'users/bob', 'Bob', ANSWERS);
    await repo.addAdmin(standup.id, 'users/bob', 'Bob');
    expect(await service.edits.ask(run.id, { userName: 'users/bob', displayName: 'Bob' }, '  ')).toEqual({ ok: true, message: '📨 Sent to your managers. You’ll hear back here.' });
    expect(adapter.dms.filter((d) => d.kind === 'editRequest').map((d) => d.userName)).toEqual(['users/lead', 'users/mgr']);
    expect((await repo.getEditRequestFor(run.id, 'users/bob'))!.reason).toBeNull();
  });

  it('says an admin decides in the web app when nobody else manages the standup', async () => {
    const { service, repo, run, standup, adapter } = await setup();
    await repo.removeAdmin(standup.id, 'users/lead');
    await repo.removeAdmin(standup.id, 'users/mgr');
    adapter.unreachable.add('users/nobody');
    expect(await service.edits.ask(run.id, { userName: 'users/alice', displayName: 'Alice' }, null)).toEqual({
      ok: true,
      message: '📨 Sent. Nobody else manages this standup in Chat, so an admin decides in the web app.',
    });
    expect((await repo.getEditRequestFor(run.id, 'users/alice'))!.status).toBe('pending');
  });

  it('allows one request per person per run, and nothing once the day ends (criteria 6 and 7)', async () => {
    const { ask, service, router, run, clock } = await setup();
    await ask();
    const waiting = 'Your request is waiting for a manager.';
    expect(status(await ask())).toEqual({ statusCode: 'INVALID_ARGUMENT', userFacingMessage: waiting });
    expect(status(await router.handle(click(OPEN_EDIT_REQUEST_FN, { runId: String(run.id) })))).toEqual({ statusCode: 'INVALID_ARGUMENT', userFacingMessage: waiting });
    const id = (await service.edits.listPending())[0]!.id;
    await service.edits.decide(id, false, { userName: 'users/lead', displayName: 'Lead', admin: false }, null);
    expect(status(await ask())).toEqual({ statusCode: 'INVALID_ARGUMENT', userFacingMessage: 'Lead declined your request, so you can’t ask again for Wed 10 Jun.' });
    clock.set('2026-06-11T00:00');
    expect(status(await router.handle(click(OPEN_EDIT_REQUEST_FN, { runId: String(run.id) })))).toEqual({ statusCode: 'INVALID_ARGUMENT', userFacingMessage: 'This standup has closed. Answers for Wed 10 Jun can no longer be added.' });
    expect(await service.edits.ask(run.id, { userName: 'users/alice', displayName: 'Alice' }, null)).toEqual({ ok: false, message: 'This standup has closed. Answers for Wed 10 Jun can no longer be added.' });
  });

  it('refuses requests that make no sense', async () => {
    const { service, run, router } = await setup();
    const me = { userName: 'users/bob', displayName: 'Bob' };
    expect(await service.edits.ask(999, me, null)).toEqual({ ok: false, message: 'This standup prompt is no longer valid.' });
    expect(await service.edits.ask(run.id, me, null)).toEqual({ ok: false, message: 'You haven’t answered yet, so there is nothing to edit. Answers can still be added late, until midnight.' });
    expect(status(await router.handle(click(SUBMIT_EDIT_REQUEST_FN, { runId: 'x' })))).toEqual({ statusCode: 'INVALID_ARGUMENT', userFacingMessage: 'This standup prompt is no longer valid.' });
    expect(status(await router.handle(click(OPEN_EDIT_REQUEST_FN, { runId: '999' })))).toEqual({ statusCode: 'INVALID_ARGUMENT', userFacingMessage: 'This standup prompt is no longer valid.' });
  });

  it('tells someone whose run is still open to edit instead', async () => {
    const stack = await makeStack();
    const standup = await seedStandup(stack.repo);
    stack.clock.set('2026-06-10T09:30');
    await stack.scheduler.tick();
    const run = (await stack.repo.getRun(standup.id, '2026-06-10'))!;
    await stack.service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    expect(await stack.service.edits.ask(run.id, { userName: 'users/alice', displayName: 'Alice' }, null)).toEqual({ ok: false, message: 'The deadline hasn’t passed, so you can still edit your answers.' });
  });
});

describe('deciding', () => {
  it('lets the first manager decide, redraws every card, and refuses the rest (criteria 8 and 9)', async () => {
    const { ask, router, adapter, repo, run, service } = await setup();
    await ask();
    const request = (await repo.getEditRequestFor(run.id, 'users/alice'))!;
    const approved: any = await router.handle(click(APPROVE_EDIT_FN, { editRequestId: String(request.id) }, lead));
    expect(approved.actionResponse).toEqual({ type: 'UPDATE_MESSAGE' });
    expect(JSON.stringify(approved)).toContain('✅ Approved by Lead at 11:31. Alice can edit until 23:59 Asia/Kolkata.');
    expect(adapter.editCardUpdates.at(-1)).toMatchObject({ messageNames: request.cardMessages, request: { status: 'approved', decidedBy: 'Lead' } });

    const late: any = await router.handle(click(APPROVE_EDIT_FN, { editRequestId: String(request.id) }, mgr));
    expect(late.actionResponse).toEqual({ type: 'UPDATE_MESSAGE' });
    expect(JSON.stringify(late)).toContain('Approved by Lead');
    expect(await service.edits.decide(request.id, false, { userName: 'users/mgr', displayName: 'Manager', admin: false }, null)).toMatchObject({ ok: false, message: 'Lead already approved this request.' });
    expect((await repo.getEditRequest(request.id))!).toMatchObject({ status: 'approved', decidedBy: 'Lead', decidedByUser: 'users/lead' });
  });

  it('only lets the standup’s managers decide, never the person asking (criterion 8)', async () => {
    const { ask, router, repo, run, service } = await setup();
    await ask();
    const id = (await repo.getEditRequestFor(run.id, 'users/alice'))!.id;
    expect(await router.handle(click(APPROVE_EDIT_FN, { editRequestId: String(id) }, bob))).toEqual({ text: 'Only the managers of Daily Standup can decide this.' });
    expect(await service.edits.decide(id, true, { userName: 'users/alice', displayName: 'Alice', admin: true }, null)).toEqual({ ok: false, message: 'Your own requests go to your managers.' });
    expect(await router.handle(click(APPROVE_EDIT_FN, { editRequestId: '999' }, lead))).toEqual({ text: 'That request no longer exists.' });
    expect((await repo.getEditRequest(id))!.status).toBe('pending');
  });

  it('asks for an optional note when declining and sends it to the person (criterion 10)', async () => {
    const { ask, router, adapter, repo, run } = await setup();
    await ask();
    const id = String((await repo.getEditRequestFor(run.id, 'users/alice'))!.id);
    const dialog: any = await router.handle(click(DECLINE_EDIT_FN, { editRequestId: id }, mgr));
    expect(dialogText(dialog)).toContain(SUBMIT_EDIT_DECLINE_FN);
    const declined: any = await router.handle(click(SUBMIT_EDIT_DECLINE_FN, { editRequestId: id }, mgr, { note: '  The wrap-up has gone out.  ' }));
    expect(status(declined)).toEqual({ statusCode: 'OK', userFacingMessage: '❌ Declined. Alice has been told.' });
    expect(adapter.dms.at(-1)).toEqual({ kind: 'text', userName: 'users/alice', text: '❌ Manager declined your request to edit your answers for Wed 10 Jun. “The wrap-up has gone out.”' });
    expect(adapter.editCardUpdates.at(-1)!.request).toMatchObject({ status: 'declined', note: 'The wrap-up has gone out.' });
    expect(adapter.cardUpdates.at(-1)!.state).toMatchObject({ edit: { status: 'declined', by: 'Manager' } });
    const again: any = await router.handle(click(SUBMIT_EDIT_DECLINE_FN, { editRequestId: id }, lead, { note: '' }));
    expect(status(again)).toEqual({ statusCode: 'INVALID_ARGUMENT', userFacingMessage: 'Manager already declined this request.' });
  });

  it('lapses undecided requests once the day ends, once (criterion 11)', async () => {
    const { ask, scheduler, adapter, repo, run, clock, service } = await setup();
    await ask();
    const id = (await repo.getEditRequestFor(run.id, 'users/alice'))!.id;
    clock.set('2026-06-10T23:59');
    await scheduler.tick();
    expect((await repo.getEditRequest(id))!.status).toBe('pending');
    clock.set('2026-06-11T00:01');
    await scheduler.tick();
    await scheduler.tick();
    expect((await repo.getEditRequest(id))!.status).toBe('lapsed');
    const lapsed = 'Your request to edit your answers for Wed 10 Jun wasn’t answered that day, so it lapsed. Your answers stay as they were.';
    expect(adapter.dms.filter((d) => d.text?.includes('lapsed'))).toEqual([{ kind: 'text', userName: 'users/alice', text: `⌛ ${lapsed}` }]);
    expect(adapter.editCardUpdates.at(-1)!.request.status).toBe('lapsed');
    expect(await service.edits.decide(id, true, { userName: 'users/lead', displayName: 'Lead', admin: false }, null)).toMatchObject({ ok: false, message: 'That request lapsed at midnight.' });
  });

  it('lapses a request someone tries to decide after midnight, before the tick does', async () => {
    const { ask, repo, run, clock, service, adapter } = await setup();
    await ask();
    const id = (await repo.getEditRequestFor(run.id, 'users/alice'))!.id;
    clock.set('2026-06-11T00:00');
    expect(await service.edits.decide(id, true, { userName: 'users/lead', displayName: 'Lead', admin: false }, null)).toMatchObject({ ok: false, message: 'That request lapsed at midnight.' });
    expect((await repo.getEditRequest(id))!.status).toBe('lapsed');
    expect(adapter.dms.filter((d) => d.kind === 'editApproved')).toEqual([]);
  });

  it('keeps going when a card cannot be sent or redrawn', async () => {
    const { ask, repo, run, service, adapter } = await setup();
    const logs: string[] = [];
    (service as any).log = (msg: string) => logs.push(msg);
    adapter.failEditCards = true;
    expect(status(await ask())).toMatchObject({ statusCode: 'OK' });
    const id = (await repo.getEditRequestFor(run.id, 'users/alice'))!.id;
    expect((await service.edits.decide(id, true, { userName: 'users/lead', displayName: 'Lead', admin: false }, null)).ok).toBe(true);
    expect(logs.some((l) => l.includes('edit request'))).toBe(true);
  });
});

describe('editing after approval', () => {
  it('sends the person a way to edit, until midnight, and marks the posted answer (criteria 12–16)', async () => {
    const { ask, router, adapter, repo, run, service, clock } = await setup();
    await ask();
    const id = (await repo.getEditRequestFor(run.id, 'users/alice'))!.id;
    await router.handle(click(APPROVE_EDIT_FN, { editRequestId: String(id) }, lead));
    expect(adapter.dms.filter((d) => d.kind === 'editApproved')).toEqual([{ kind: 'editApproved', userName: 'users/alice', editRequest: expect.objectContaining({ status: 'approved', decidedBy: 'Lead' }) }]);
    expect(adapter.cardUpdates.at(-1)!.state).toMatchObject({ edit: { status: 'approved', by: 'Lead', until: '23:59 Asia/Kolkata' } });

    const form: any = await router.handle(click(OPEN_DIALOG_FN, { runId: String(run.id) }));
    expect(dialogText(form)).toContain('"name":"q0"');
    const summaries = adapter.posts.filter((p) => p.kind === 'summary').length;
    clock.set('2026-06-10T14:00');
    expect(await service.submit(run.id, 'users/alice', 'Alice', ANSWERS)).toEqual({ ok: true, late: false, edited: true });
    expect(await service.submit(run.id, 'users/alice', 'Alice', ANSWERS)).toEqual({ ok: true, late: false, edited: true });
    const update = adapter.posts.at(-1)!;
    expect(update).toMatchObject({ kind: 'update', payload: { editApprovedBy: 'Lead' } });
    expect(submissionMessage(update.payload as any).cardsV2[0]!.card.header.subtitle).toBe('Edited after the deadline · approved by Lead');
    expect(adapter.posts.filter((p) => p.kind === 'summary').length).toBe(summaries);

    clock.set('2026-06-11T00:00');
    expect(await service.submit(run.id, 'users/alice', 'Alice', ANSWERS)).toEqual({ ok: false, reason: 'day_closed' });
  });

  it('still refuses an edit after the deadline without approval', async () => {
    const { service, run, router } = await setup();
    expect(await service.submit(run.id, 'users/alice', 'Alice', ANSWERS)).toEqual({ ok: false, reason: 'already_submitted' });
    const reply: any = await router.handle(click('submitStandup', { runId: String(run.id) }, alice, { q0: 'a', q1: 'b', q2: 'none', mood: 'good' }));
    expect(status(reply)).toEqual({ statusCode: 'INVALID_ARGUMENT', userFacingMessage: 'The deadline has passed. Ask a manager to let you edit, from your prompt card.' });
  });

  it('names the approver in the submission webhook (criterion 15)', async () => {
    const bodies: any[] = [];
    const webhookFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('ok');
    }) as unknown as typeof fetch;
    const { ask, repo, run, service, standup } = await setup({ webhookFetch });
    await repo.updateStandup(standup.id, { webhookUrl: 'https://hooks.example.com/x' });
    await ask();
    const id = (await repo.getEditRequestFor(run.id, 'users/alice'))!.id;
    await service.edits.decide(id, true, { userName: 'users/lead', displayName: 'Lead', admin: false }, null);
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    expect(bodies.filter((b) => b.event === 'submission').at(-1)).toMatchObject({ edited: true, editApprovedBy: 'Lead' });
  });
});

describe('edit request cards', () => {
  const standup = { id: 1, name: 'Engineering', timezone: 'Europe/London' } as any;
  const view = (over: Record<string, unknown> = {}) =>
    ({
      id: 7,
      runId: 3,
      standup,
      date: '2026-10-15',
      person: { userName: 'users/priya', displayName: 'Priya' },
      reason: 'Wrong ticket number',
      status: 'pending',
      askedAt: '2026-10-15T10:42:00.000Z',
      answeredAt: '2026-10-15T08:12:00.000Z',
      decidedAt: null,
      decidedBy: null,
      note: null,
      until: '23:59 Europe/London',
      ...over,
    }) as any;

  it('shows the manager who, which day, the reason and the buttons, then the outcome', () => {
    const pending = JSON.stringify(editRequestCard(view()));
    expect(pending).toContain('"title":"Edit request · Engineering"');
    expect(pending).toContain('"subtitle":"Priya · Thu 15 Oct · answered at 09:12"');
    expect(pending).toContain('“Wrong ticket number” Approve and Priya can edit their answers until 23:59 Europe/London. Decline and Priya is told, with your note. Unanswered by then, it lapses.');
    expect(pending).toContain(APPROVE_EDIT_FN);
    expect(pending).toContain(DECLINE_EDIT_FN);
    const noReason = JSON.stringify(editRequestCard(view({ reason: null })));
    expect(noReason).toContain('"text":"Approve and Priya');
    const approved = JSON.stringify(editRequestCard(view({ status: 'approved', decidedBy: 'Asha', decidedAt: '2026-10-15T10:50:00.000Z' })));
    expect(approved).toContain('✅ Approved by Asha at 11:50. Priya can edit until 23:59 Europe/London.');
    expect(approved).not.toContain(APPROVE_EDIT_FN);
    expect(JSON.stringify(editRequestCard(view({ status: 'declined', decidedBy: 'Asha', decidedAt: '2026-10-15T10:50:00.000Z', note: 'Too late' })))).toContain('❌ Declined by Asha at 11:50. “Too late”');
    expect(JSON.stringify(editRequestCard(view({ status: 'declined', decidedBy: 'Asha', decidedAt: '2026-10-15T10:50:00.000Z' })))).toContain('❌ Declined by Asha at 11:50.');
    expect(JSON.stringify(editRequestCard(view({ status: 'lapsed' })))).toContain('⌛ Lapsed: not decided by 23:59 Europe/London.');
  });

  it('gives the person an Edit answers button once approved', () => {
    const card = JSON.stringify(editApprovedCard(view({ status: 'approved', decidedBy: 'Asha' })));
    expect(card).toContain('✅ Asha approved your request. Edit your answers before <b>23:59 Europe/London</b>.');
    expect(card).toContain(`"text":"Edit answers","onClick":{"action":{"function":"${OPEN_DIALOG_FN}","interaction":"OPEN_DIALOG","parameters":[{"key":"runId","value":"3"}]`);
  });

  it('asks why in the request dialog', () => {
    const run = { id: 3, date: '2026-10-15' } as any;
    const dialog = JSON.stringify(editRequestDialog(standup, run, 'https://x.example/chat', { error: 'Keep it to 200 characters.', reason: 'abc' }));
    expect(dialog).toContain('<b>Ask to edit · Engineering · Thu 15 Oct</b><br>Your managers decide. If they approve, you can edit until 23:59 Europe/London.');
    expect(dialog).toContain('"label":"Why? (optional)"');
    expect(dialog).toContain('"value":"abc"');
    expect(dialog).toContain('Sent to your managers with the request. Up to 200 characters.');
    expect(dialog).toContain('{"key":"fn","value":"submitEditRequest"}');
  });

  it('shows the prompt card’s later states', () => {
    const run = { id: 3, date: '2026-10-15' } as any;
    const at = '2026-10-15T08:12:00.000Z';
    const card = (edit: any, late = false) => JSON.stringify(promptMessage({ ...standup, deadlineTime: '11:30' }, run, null, { kind: 'submitted', at, late, closed: true, edit }));
    expect(card(null, true)).toContain('✅ Submitted at <b>09:12</b> (late). The deadline has passed.');
    expect(card({ status: 'pending', by: null, until: '23:59 Europe/London' })).toContain('Your request to edit is waiting for a manager.');
    const approved = card({ status: 'approved', by: 'Asha', until: '23:59 Europe/London' });
    expect(approved).toContain('Asha approved your request: you can edit your answers until <b>23:59 Europe/London</b>.');
    expect(approved).toContain('"text":"Edit answers"');
    expect(card({ status: 'declined', by: 'Asha', until: '23:59 Europe/London' })).toContain('Asha declined your request to edit.');
    expect(card({ status: 'lapsed', by: null, until: '23:59 Europe/London' })).toContain('Your request to edit lapsed.');
    expect(card({ status: 'lapsed', by: null, until: '23:59 Europe/London' })).not.toContain('buttonList');
  });

  it('marks a posted answer edited after the deadline', () => {
    const base = { id: 1, displayName: 'Priya', answers: [], late: false, editedAt: 'x', editApprovedBy: 'Asha' } as any;
    expect(submissionMessage(base).cardsV2[0]!.card.header.subtitle).toBe('Edited after the deadline · approved by Asha');
    expect(submissionMessage({ ...base, late: true }).cardsV2[0]!.card.header.subtitle).toBe('Submitted late · edited after the deadline · approved by Asha');
  });
});

const SECRET = 'api-test-secret';
const OPERATOR = 'dash-secret';
const CSRF = { 'x-requested-with': 'asyncup', 'content-type': 'application/json' };
let close: (() => void) | null = null;
afterEach(() => close?.());

async function startServer(withService = true) {
  const stack = await setup();
  const app = createServer({
    router: stack.router,
    scheduler: stack.scheduler,
    adapter: stack.adapter,
    blockers: stack.blockers,
    repo: stack.repo,
    settings: stack.settings,
    dashboardToken: OPERATOR,
    skipVerification: true,
    secretKey: SECRET,
    service: withService ? stack.service : undefined,
    schedule: stack.schedule,
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookieFor = (sub: string, name = sub) => `asyncup_sess=${sealSession(SECRET, newSession({ sub, email: `${sub}@o.com`, name, admin: false }))}`;
  const op = (path: string, init: RequestInit = {}) => fetch(`${url}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' } });
  const as = (cookie: string, path: string, init: RequestInit = {}) => fetch(`${url}/api/v1${path}`, { ...init, headers: { cookie, ...CSRF } });
  return { ...stack, op, as, cookieFor };
}

describe('edit requests API', () => {
  it('lists pending requests to people who can decide them, and decides them (criterion 8)', async () => {
    const { op, as, cookieFor, ask, repo, run, adapter, standup } = await startServer();
    await ask();
    const id = (await repo.getEditRequestFor(run.id, 'users/alice'))!.id;
    const other = await repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/other', name: 'Other', timezone: 'UTC' });
    await repo.addAdmin(other.id, 'users/ops', 'Ops');

    const all: any = await (await op('/edit-requests')).json();
    expect(all).toEqual({
      requests: [
        {
          id,
          standupId: standup.id,
          standupName: 'Daily Standup',
          date: '2026-06-10',
          userName: 'users/alice',
          displayName: 'Alice',
          reason: 'Wrong ticket number under Today',
          askedAt: expect.any(String),
          answeredAt: expect.any(String),
          until: '23:59 Asia/Kolkata',
        },
      ],
    });
    expect(((await (await as(cookieFor('lead', 'Lead'), '/edit-requests')).json()) as any).requests).toHaveLength(1);
    expect(((await (await as(cookieFor('ops', 'Ops'), '/edit-requests')).json()) as any).requests).toEqual([]);
    expect((await as(cookieFor('bob', 'Bob'), '/edit-requests')).status).toBe(403);

    expect((await as(cookieFor('ops', 'Ops'), `/edit-requests/${id}/approve`, { method: 'POST' })).status).toBe(403);
    expect((await op('/edit-requests/999/approve', { method: 'POST' })).status).toBe(404);
    expect((await op('/edit-requests/abc/approve', { method: 'POST' })).status).toBe(404);
    let res = await as(cookieFor('lead', 'Lead'), `/edit-requests/${id}/decline`, { method: 'POST', body: JSON.stringify({ note: 'Not today' }) });
    expect(await res.json()).toEqual({ ok: true, message: '❌ Declined. Alice has been told.' });
    expect(adapter.dms.at(-1)!.text).toContain('“Not today”');
    res = await op(`/edit-requests/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'refused', message: 'Lead already declined this request.' } });
  });

  it('lets the operator approve, and answers 503 without the standup service', async () => {
    const { op, ask, repo, run } = await startServer();
    await ask();
    const id = (await repo.getEditRequestFor(run.id, 'users/alice'))!.id;
    expect(await (await op(`/edit-requests/${id}/approve`, { method: 'POST' })).json()).toEqual({ ok: true, message: '✅ Approved. Alice can edit until 23:59 Asia/Kolkata.' });
    expect((await repo.getEditRequest(id))!.decidedBy).toBe('Operator');
    close?.();
    const bare = await startServer(false);
    expect((await bare.op('/edit-requests')).status).toBe(503);
    expect((await bare.op('/edit-requests/1/approve', { method: 'POST' })).status).toBe(503);
  });
});
