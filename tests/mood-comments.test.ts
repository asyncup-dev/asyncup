import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { buildCsv } from '../src/core/export.js';
import { BUILT_IN_ROLES } from '../src/core/permissions.js';
import { createServer } from '../src/server.js';
import { ANSWERS, makeStack, seedStandup, TENANT } from './helpers.js';

const SECRET = 'mood-comments-secret';
const OPERATOR = 'mood-comments-operator';
let close: (() => void) | null = null;

afterEach(() => {
  close?.();
  close = null;
});

function formEvent(runId: number, inputs: Record<string, string>, user = { name: 'users/alice', displayName: 'Alice', type: 'HUMAN' }) {
  const formInputs = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, { stringInputs: { value: [v] } }]));
  return {
    type: 'CARD_CLICKED',
    isDialogEvent: true,
    common: { invokedFunction: 'submitStandup', parameters: { runId: String(runId) }, formInputs },
    user,
    space: { name: 'spaces/dm-alice', spaceType: 'DIRECT_MESSAGE' },
  };
}

const FORM = { q0: 'Did X', q1: 'Will do Y', q2: 'none', mood: 'meh' };

async function chatStack() {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const standup = await seedStandup(stack.repo);
  await stack.repo.updateStandup(standup.id, { moodEnabled: true });
  stack.clock.set('2026-06-10T09:31');
  await stack.scheduler.tick();
  const run = (await stack.repo.getRun(standup.id, '2026-06-10'))!;
  const mine = () => stack.repo.getSubmission(run.id, 'users/alice');
  return { ...stack, router, standup, run, mine };
}

const widgetsOf = (reply: any) => reply.actionResponse.dialogAction.dialog.body.sections[0].widgets as any[];

describe('answering with a mood comment', () => {
  it('stores an optional comment, clears it when emptied, and fills it in when editing (criteria 1, 2, 4)', async () => {
    const { router, run, mine } = await chatStack();
    await router.handle(formEvent(run.id, { ...FORM, moodComment: '  Short night  ' }));
    expect(await mine()).toMatchObject({ mood: 'meh', moodComment: 'Short night' });

    const open: any = await router.handle({
      type: 'CARD_CLICKED',
      common: { invokedFunction: 'openStandupDialog', parameters: { runId: String(run.id) } },
      user: { name: 'users/alice', displayName: 'Alice' },
      space: { name: 'spaces/dm-alice', spaceType: 'DIRECT_MESSAGE' },
    });
    const widgets = widgetsOf(open);
    expect(widgets.find((w) => w.textInput?.name === 'moodComment').textInput.value).toBe('Short night');
    expect(widgets.find((w) => w.selectionInput).selectionInput.items.find((i: any) => i.selected).value).toBe('meh');

    await router.handle(formEvent(run.id, { ...FORM, mood: 'good', moodComment: '' }));
    expect(await mine()).toMatchObject({ mood: 'good', moodComment: null });
  });

  it('refuses a comment over 200 characters and keeps everything typed (criterion 3)', async () => {
    const { router, run, mine } = await chatStack();
    const long = 'x'.repeat(201);
    const reply: any = await router.handle(formEvent(run.id, { ...FORM, moodComment: long }));
    const widgets = widgetsOf(reply);
    expect(widgets[0].textParagraph.text).toContain('Keep it to 200 characters.');
    expect(widgets.find((w) => w.textInput?.name === 'q0').textInput.value).toBe('Did X');
    expect(widgets.find((w) => w.textInput?.name === 'moodComment').textInput.value).toBe(long);
    expect(await mine()).toBeNull();
    await router.handle(formEvent(run.id, { ...FORM, moodComment: 'x'.repeat(200) }));
    expect((await mine())!.moodComment).toHaveLength(200);
  });

  it('stores no comment when the standup has mood off (criterion 5)', async () => {
    const { router, run, repo, standup, mine } = await chatStack();
    await repo.updateStandup(standup.id, { moodEnabled: false });
    await router.handle(formEvent(run.id, { q0: 'a', q1: 'b', q2: 'none', moodComment: 'Sneaked in' }));
    expect(await mine()).toMatchObject({ mood: null, moodComment: null });
  });

  it('keeps everyone’s mood out of `status` (criterion 11)', async () => {
    const { commands, service, run } = await chatStack();
    await service.submit(run.id, 'users/alice', 'Alice', { ...ANSWERS, mood: 'great', moodComment: 'Shipped it' });
    const reply = await commands.handle({ tenantId: TENANT, spaceName: 'spaces/team', text: 'status', mentions: [], sender: { userName: 'users/bob', displayName: 'Bob' } });
    expect(reply).not.toMatch(/😄|Shipped it/);
  });
});

describe('mood comments never leave the app', () => {
  it('leaves comments out of CSV exports and webhooks (criterion 17)', async () => {
    const bodies: string[] = [];
    const stack = await makeStack({ webhookFetch: (async (_url: string, init: RequestInit) => { bodies.push(String(init.body)); return new Response(null, { status: 204 }); }) as typeof fetch });
    const standup = await seedStandup(stack.repo);
    await stack.repo.updateStandup(standup.id, { moodEnabled: true, webhookUrl: 'https://hooks.example.com/x' });
    const run = await stack.repo.createRun(standup.id, '2026-06-10', 'k');
    await stack.service.submit(run.id, 'users/alice', 'Alice', { ...ANSWERS, mood: 'meh', moodComment: 'Short night' });
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.join()).not.toContain('Short night');
    expect(await buildCsv(stack.repo, standup, '2026-06-01', '2026-06-30')).not.toContain('Short night');
  });
});

describe('the Read mood comments permission', () => {
  it('is in the catalogue, can be granted on one standup, and only Admin holds it (criteria 18, 19)', async () => {
    const { send } = await startServer();
    const listed = (await send(null, 'GET', '/permissions')).body.permissions.find((p: any) => p.id === 'moods.comments');
    expect(listed).toEqual({ id: 'moods.comments', label: 'Read mood comments', description: expect.any(String), workspaceOnly: false });
    expect(BUILT_IN_ROLES.admin.permissions).toContain('moods.comments');
    for (const role of [BUILT_IN_ROLES.manager, BUILT_IN_ROLES.viewer, BUILT_IN_ROLES.member]) expect(role.permissions).not.toContain('moods.comments');
  });

  it('shows named comments to holders, nothing to others, and nameless sorted comments on anonymous standups (criteria 13–16)', async () => {
    const { send, s, run, service, repo } = await startServer();
    await service.submit(run.id, 'users/alice', 'Alice', { ...ANSWERS, mood: 'meh', moodComment: 'Short night' });
    await service.submit(run.id, 'users/bob', 'Bob', { ...ANSWERS, mood: 'great' });
    await service.submit(run.id, 'users/carol', 'Carol', { ...ANSWERS, mood: 'struggling', moodComment: 'Too many meetings' });
    const path = `/standups/${s.id}/runs/2026-06-10`;

    // A Google or SAML admin holds every permission.
    expect((await send('root', 'GET', path)).body.moodComments).toEqual([
      { person: { userName: 'users/alice', displayName: 'Alice' }, mood: 'meh', comment: 'Short night' },
      { person: { userName: 'users/carol', displayName: 'Carol' }, mood: 'struggling', comment: 'Too many meetings' },
    ]);
    // Bob manages the standup but cannot read comments.
    const asManager = (await send('bob', 'GET', path)).body;
    expect(asManager.submissions).toHaveLength(3);
    expect('moodComments' in asManager).toBe(false);

    // A custom role on this standup only.
    const role = (await send(null, 'POST', '/roles', { name: 'Wellbeing', permissions: ['answers.view', 'moods.comments'] })).body;
    await send(null, 'POST', '/grants', { email: 'dan@o.com', role: role.id, standupId: s.id });
    expect((await send('dan', 'GET', path)).body.moodComments).toHaveLength(2);

    // Anonymous moods: no names, sorted by mood then text, whoever wrote first.
    await repo.updateStandup(s.id, { moodAnonymous: true });
    expect((await send('root', 'GET', path)).body.moodComments).toEqual([
      { person: null, mood: 'struggling', comment: 'Too many meetings' },
      { person: null, mood: 'meh', comment: 'Short night' },
    ]);

    // Everyone sees their own comment on My standups.
    const mine = (await send('alice', 'GET', '/me/submissions')).body.submissions;
    expect(mine[0]).toMatchObject({ mood: 'meh', moodComment: 'Short night' });
  });
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
    dashboardToken: OPERATOR,
    skipVerification: true,
    secretKey: SECRET,
    service: stack.service,
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = (sub: string) => `asyncup_sess=${sealSession(SECRET, newSession({ sub, email: `${sub}@o.com`, name: sub, admin: sub === 'root' }))}`;
  const send = async (who: string | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = who === null ? { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' } : { cookie: cookie(who), 'x-requested-with': 'asyncup', 'content-type': 'application/json' };
    const res = await fetch(`${url}/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const s = await seedStandup(stack.repo);
  await stack.repo.updateStandup(s.id, { moodEnabled: true });
  await stack.repo.addAdmin(s.id, 'users/bob', 'Bob');
  const run = await stack.repo.createRun(s.id, '2026-06-10', 'k');
  return { ...stack, send, s, run };
}
