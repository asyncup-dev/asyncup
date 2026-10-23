import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import { createServer } from '../src/server.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const SECRET = 'api-test-secret';
const OPERATOR = 'dash-secret';
const CSRF = { 'x-requested-with': 'asyncup', 'content-type': 'application/json' };
let close: (() => void) | null = null;
afterEach(() => close?.());

const DRAFT = {
  title: 'Release retro',
  questions: [
    { text: 'What went well?', type: 'long', required: true },
    { text: 'Which day?', type: 'single', required: true, options: ['Monday', 'Tuesday'] },
  ],
  closesAt: '2026-06-10T17:00',
  remindMinutes: 60,
};

async function startServer(withService = true) {
  const stack = await makeStack();
  const standup = await seedStandup(stack.repo);
  await stack.repo.addAdmin(standup.id, 'users/mgr', 'Manager');
  stack.clock.set('2026-06-10T10:00');
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
    ...(withService ? { service: stack.service } : {}),
    schedule: stack.schedule,
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookieFor = (sub: string, name = sub) => `asyncup_sess=${sealSession(SECRET, newSession({ sub, email: `${sub}@o.com`, name, admin: false }))}`;
  const as = (cookie: string, path: string, init: RequestInit = {}) => fetch(`${url}/api/v1${path}`, { ...init, headers: { cookie, ...CSRF, ...(init.headers as Record<string, string>) } });
  const op = (path: string, init: RequestInit = {}) => fetch(`${url}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } });
  const json = (body: unknown) => JSON.stringify(body);
  return { ...stack, standup, as, op, json, mgr: cookieFor('mgr', 'Manager'), alice: cookieFor('alice', 'Alice') };
}

describe('poll API', () => {
  it('lets managers send polls, checks drafts, and lists them for the standup (criteria 1, 19)', async () => {
    const { as, json, standup, mgr, alice } = await startServer();
    const path = `/standups/${standup.id}/question-polls`;
    expect((await as(alice, path, { method: 'POST', body: json(DRAFT) })).status).toBe(403);
    expect(await (await as(mgr, path, { method: 'POST', body: json({ ...DRAFT, title: '' }) })).json()).toMatchObject({ error: { code: 'invalid', field: 'title', message: 'Give the poll a title.' } });
    const res = await as(mgr, path, { method: 'POST', body: json(DRAFT) });
    expect(res.status).toBe(201);
    const poll: any = await res.json();
    expect(poll).toMatchObject({ title: 'Release retro', from: 'Manager', closesAt: '2026-06-10T11:30:00.000Z', closesLabel: 'Wed 10 Jun, 17:00 Asia/Kolkata', open: true, anonymous: false, results: 'everyone', asked: 3, answered: 0, remindAt: '2026-06-10T10:30:00.000Z', intro: null });
    expect(poll.questions[0]).toEqual({ text: 'What went well?', type: 'long', required: true, options: [] });
    const list: any = await (await as(alice, path)).json();
    expect(list.polls.map((x: any) => [x.id, x.answered])).toEqual([[poll.id, 0]]);
    expect((await as(alice, '/question-polls/999')).status).toBe(404);
  });

  it('shows results to managers, and to the people asked once an everyone-sees poll closes (criterion 16)', async () => {
    const { as, json, standup, mgr, alice, service } = await startServer();
    const poll: any = await (await as(mgr, `/standups/${standup.id}/question-polls`, { method: 'POST', body: json(DRAFT) })).json();
    await service.questionPolls.answer(poll.id, { userName: 'users/alice', displayName: 'Alice' }, ['The rollout', [0]]);
    expect(((await (await as(alice, `/question-polls/${poll.id}`)).json()) as any).outcome).toBeNull();
    const open: any = await (await as(mgr, `/question-polls/${poll.id}`)).json();
    expect(open.outcome).toEqual({
      notAnswered: ['Bob', 'Carol'],
      questions: [
        { text: 'What went well?', type: 'long', answered: 1, options: [], answers: [{ name: 'Alice', text: 'The rollout' }] },
        { text: 'Which day?', type: 'single', answered: 1, options: [{ text: 'Monday', count: 1, names: ['Alice'] }, { text: 'Tuesday', count: 0, names: [] }], answers: [] },
      ],
    });
    expect((await as(alice, `/question-polls/${poll.id}/close`, { method: 'POST' })).status).toBe(403);
    const closed: any = await (await as(mgr, `/question-polls/${poll.id}/close`, { method: 'POST' })).json();
    expect(closed).toMatchObject({ open: false, closedAt: '2026-06-10T04:30:00.000Z', closedLabel: 'Wed 10 Jun, 10:00 Asia/Kolkata' });
    expect((await as(mgr, `/question-polls/${poll.id}/close`, { method: 'POST' })).status).toBe(409);
    expect(((await (await as(alice, `/question-polls/${poll.id}`)).json()) as any).outcome.questions[1].options[0].names).toEqual(['Alice']);
  });

  it('keeps managers-only results from the people asked, and names out of anonymous polls (criteria 16, 17)', async () => {
    const { as, json, standup, mgr, alice, service } = await startServer();
    const managers: any = await (await as(mgr, `/standups/${standup.id}/question-polls`, { method: 'POST', body: json({ ...DRAFT, results: 'managers' }) })).json();
    await as(mgr, `/question-polls/${managers.id}/close`, { method: 'POST' });
    expect(((await (await as(alice, `/question-polls/${managers.id}`)).json()) as any).outcome).toBeNull();
    const anon: any = await (await as(mgr, `/standups/${standup.id}/question-polls`, { method: 'POST', body: json({ ...DRAFT, anonymous: true }) })).json();
    await service.questionPolls.answer(anon.id, { userName: 'users/alice', displayName: 'Alice' }, ['The rollout', [1]]);
    const seen: any = await (await as(mgr, `/question-polls/${anon.id}`)).json();
    expect(seen.outcome.notAnswered).toBeNull();
    expect(seen.outcome.questions[0].answers).toEqual([{ name: null, text: 'The rollout' }]);
    expect(seen.outcome.questions[1].options[1]).toEqual({ text: 'Tuesday', count: 1, names: null });
  });

  it('exports CSV for managers, without the person on an anonymous poll (criterion 18)', async () => {
    const { as, json, standup, mgr, alice, service } = await startServer();
    const named: any = await (await as(mgr, `/standups/${standup.id}/question-polls`, { method: 'POST', body: json(DRAFT) })).json();
    await service.questionPolls.answer(named.id, { userName: 'users/alice', displayName: 'Alice' }, ['=SUM(A1), "quoted"', [1]]);
    expect((await as(alice, `/question-polls/${named.id}/export.csv`)).status).toBe(403);
    const res = await as(mgr, `/question-polls/${named.id}/export.csv`);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(await res.text()).toBe(`person,question,answer,answered_at\nAlice,What went well?,"'=SUM(A1), ""quoted""",2026-06-10T04:30:00.000Z\nAlice,Which day?,Tuesday,2026-06-10T04:30:00.000Z\n`);
    const anon: any = await (await as(mgr, `/standups/${standup.id}/question-polls`, { method: 'POST', body: json({ ...DRAFT, anonymous: true }) })).json();
    await service.questionPolls.answer(anon.id, { userName: 'users/alice', displayName: 'Alice' }, ['Fine', [0]]);
    expect((await (await as(mgr, `/question-polls/${anon.id}/export.csv`)).text()).split('\n')[0]).toBe('question,answer,answered_at');
  });

  it('answers 503 without the standup service', async () => {
    const { op, standup } = await startServer(false);
    expect((await op(`/standups/${standup.id}/question-polls`)).status).toBe(503);
  });
});
