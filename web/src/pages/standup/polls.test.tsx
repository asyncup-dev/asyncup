import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MANAGER, MEMBER, renderApp, stubApi } from '../../test/harness';

const ENG = {
  id: 1, name: 'Engineering', spaceName: 'spaces/A', active: true,
  schedule: { promptTime: '09:30', deadlineTime: '11:30', timezone: 'Asia/Kolkata', days: ['mon', 'tue', 'wed', 'thu', 'fri'], reminderMinutesBefore: 30 },
  questions: ['Q1?'], mood: { enabled: false, anonymous: false }, digestEnabled: false, timeOffPolicy: 'self',
  escalation: { afterDays: 2, contact: null }, webhook: { configured: false }, roster: { group: null, syncedAt: null, error: null, leftSpace: [] },
  people: { total: 8, mandatory: 8 },
  today: { date: '2026-10-23', status: null, submitted: 0, expected: 0, missing: [] },
  permissions: { manage: true }, participants: [], admins: [], keptOff: [],
};
const summary = (over: Record<string, unknown> = {}) => ({
  id: 5, standupId: 1, title: 'Release retro', from: 'Asha', createdAt: '2026-10-23T05:30:00.000Z', closesAt: '2026-10-24T11:30:00.000Z',
  closesLabel: 'Fri 24 Oct, 17:00 Asia/Kolkata', closedAt: null, closedLabel: null, open: true, anonymous: false, results: 'everyone', asked: 8, answered: 3, ...over,
});
const POLL = {
  ...summary({ open: false, closedAt: '2026-10-24T11:30:00.000Z', closedLabel: 'Fri 24 Oct, 17:00 Asia/Kolkata', answered: 7 }),
  intro: null, remindAt: null,
  questions: [
    { text: 'What went well?', type: 'long', required: true, options: [] },
    { text: 'Which day suits the retro?', type: 'single', required: true, options: ['Monday', 'Tuesday'] },
  ],
  outcome: {
    notAnswered: ['Farhan Ali'],
    questions: [
      { text: 'What went well?', type: 'long', answered: 2, options: [], answers: [{ name: 'Asha Verma', text: 'The staged rollout' }, { name: 'Bob Mehta', text: 'Pairing' }] },
      { text: 'Which day suits the retro?', type: 'single', answered: 7, options: [{ text: 'Monday', count: 5, names: ['Asha Verma', 'Bob Mehta'] }, { text: 'Tuesday', count: 2, names: [] }], answers: [] },
    ],
  },
};

function server(over: Record<string, { status?: number; body: unknown }> = {}, me: unknown = MANAGER) {
  const bodies: Record<string, unknown>[] = [];
  const record = (reply: unknown) => (init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body ?? '{}'))); return reply; };
  return {
    bodies,
    ...stubApi({
      'GET /api/v1/me': { body: me },
      'GET /api/v1/standups': { body: { standups: [ENG] } },
      'GET /api/v1/standups/1': { body: ENG },
      'GET /api/v1/standups/1/question-polls': { body: { polls: [summary(), summary({ id: 4, title: 'On-call preferences', open: false, closedLabel: 'Fri 17 Oct, 18:00 Asia/Kolkata', anonymous: true, results: 'managers', answered: 6 })] } },
      'POST /api/v1/standups/1/question-polls': { body: record({ ...POLL, id: 5 }) },
      'GET /api/v1/question-polls/5': { body: POLL },
      'POST /api/v1/question-polls/5/close': { body: POLL },
      ...over,
    }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('the Polls tab', () => {
  it('lists open and closed polls with how many answered, and New poll for managers (criteria 1, 13)', async () => {
    server();
    renderApp('/standups/1/polls');
    expect(await screen.findByText('Release retro')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Polls' })).toBeInTheDocument();
    expect(screen.getByText('Sent by Asha · 3 of 8 answered · closes Fri 24 Oct, 17:00 Asia/Kolkata')).toBeInTheDocument();
    expect(screen.getByText('Sent by Asha · 6 of 8 answered · closed Fri 17 Oct, 18:00 Asia/Kolkata')).toBeInTheDocument();
    expect(screen.getByText('Anonymous')).toBeInTheDocument();
    expect(screen.getByText('Managers only')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New poll' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Results' })).toBeInTheDocument();
  });

  it('hides New poll from people who can’t send one, and says when nothing is open', async () => {
    server({ 'GET /api/v1/standups/1/question-polls': { body: { polls: [] } } }, MEMBER);
    renderApp('/standups/1/polls');
    expect(await screen.findByText('No open polls.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New poll' })).not.toBeInTheDocument();
  });
});

describe('a new poll', () => {
  it('builds questions of each kind, previews them and sends the draft (criteria 1–5)', async () => {
    const { bodies, calls } = server();
    renderApp('/standups/1/polls/new');
    const user = userEvent.setup();
    expect(await screen.findByText('Sent by DM to the 8 people on Engineering. People on vacation are skipped.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Release retro');
    await user.type(screen.getByLabelText('Question 1 text'), 'What went well?');
    await user.selectOptions(screen.getByLabelText('Question 1 type'), 'long');
    await user.click(within(screen.getByRole('group', { name: 'Question 1' })).getByLabelText('Required'));
    await user.click(screen.getByRole('button', { name: '+ Add question' }));
    await user.type(screen.getByLabelText('Question 2 text'), 'Which day?');
    await user.selectOptions(screen.getByLabelText('Question 2 type'), 'single');
    await user.type(screen.getByLabelText('Question 2 option 1'), 'Monday');
    await user.type(screen.getByLabelText('Question 2 option 2'), 'Tuesday');
    await user.click(screen.getByRole('button', { name: '+ Add option' }));
    await user.type(screen.getByLabelText('Question 2 option 3'), 'Friday');
    await user.click(screen.getByRole('button', { name: 'Remove question 2 option 3' }));
    await user.click(screen.getByRole('button', { name: 'Move question 2 up' }));
    await user.click(screen.getByRole('button', { name: '+ Add question' }));
    await user.click(screen.getByRole('button', { name: 'Remove question 3' }));
    // The preview follows the builder.
    const preview = within(screen.getByRole('region', { name: 'Preview' }));
    expect(preview.getByText('Release retro')).toBeInTheDocument();
    expect(preview.getByText('What went well? (required)')).toBeInTheDocument();
    expect(preview.getByText('○ Monday')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Close date'), { target: { value: '2026-10-24' } });
    fireEvent.change(screen.getByLabelText('Close time'), { target: { value: '17:00' } });
    await user.selectOptions(screen.getByLabelText('Reminder'), '');
    await user.click(screen.getByLabelText('Anonymous — nobody sees who answered what'));
    await user.selectOptions(screen.getByLabelText('Who sees results'), 'managers');
    await user.click(screen.getByRole('button', { name: 'Send poll' }));
    await waitFor(() => expect(bodies).toEqual([{
      title: 'Release retro',
      intro: null,
      questions: [
        { text: 'Which day?', type: 'single', required: false, options: ['Monday', 'Tuesday'] },
        { text: 'What went well?', type: 'long', required: true, options: [] },
      ],
      closesAt: '2026-10-24T17:00',
      remindMinutes: null,
      anonymous: true,
      results: 'managers',
    }]));
    await waitFor(() => expect(calls).toContain('GET /api/v1/question-polls/5'));
  });

  it('shows why a draft was refused', async () => {
    server({ 'POST /api/v1/standups/1/question-polls': { status: 400, body: { error: { code: 'invalid', field: 'title', message: 'Give the poll a title.' } } } });
    renderApp('/standups/1/polls/new');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Send poll' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Give the poll a title.');
  });
});

describe('poll results', () => {
  it('shows who answered, bars per option with names, and every text answer; managers can close early (criteria 13, 16)', async () => {
    const { calls } = server({ 'GET /api/v1/question-polls/5': { body: { ...POLL, ...summary(), open: true, outcome: POLL.outcome } } });
    renderApp('/standups/1/polls/5');
    const user = userEvent.setup();
    expect(await screen.findByText('3 of 8 answered')).toBeInTheDocument();
    expect(screen.getByText('Not answered: Farhan Ali')).toBeInTheDocument();
    const day = within(screen.getByRole('region', { name: 'Question 2 results' }));
    expect(day.getByText('Monday')).toBeInTheDocument();
    expect(day.getByText('5')).toBeInTheDocument();
    expect(day.getByText('Asha Verma, Bob Mehta')).toBeInTheDocument();
    const well = within(screen.getByRole('region', { name: 'Question 1 results' }));
    expect(well.getByText('The staged rollout')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Export this poll as CSV' })).toHaveAttribute('href', '/api/v1/question-polls/5/export.csv');
    await user.click(screen.getByRole('button', { name: 'Close now' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close now' }));
    await waitFor(() => expect(calls).toContain('POST /api/v1/question-polls/5/close'));
  });

  it('tells the people asked when results aren’t theirs to see yet', async () => {
    server({ 'GET /api/v1/question-polls/5': { body: { ...POLL, results: 'managers', outcome: null } } }, MEMBER);
    renderApp('/standups/1/polls/5');
    expect(await screen.findByText('Results are with the standup’s managers.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Export this poll as CSV' })).not.toBeInTheDocument();
  });

  it('shows anonymous answers without names, and says results come at the close', async () => {
    server({ 'GET /api/v1/question-polls/5': { body: { ...POLL, anonymous: true, outcome: { notAnswered: null, questions: [{ ...POLL.outcome.questions[0], answers: [{ name: null, text: 'Quiet win' }] }, { ...POLL.outcome.questions[1], options: [{ text: 'Monday', count: 0, names: null }] }] } } } });
    renderApp('/standups/1/polls/5');
    expect(await screen.findByText('Quiet win')).toBeInTheDocument();
    expect(screen.queryByText(/Not answered/)).not.toBeInTheDocument();
    expect(screen.getByText(/Anonymous/)).toBeInTheDocument();
  });
});
