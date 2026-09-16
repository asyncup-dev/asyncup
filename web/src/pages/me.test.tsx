import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEMBER, renderApp, stubApi } from '../test/harness';
import { greeting, moodSummary } from './me';

const MINE = {
  linked: true,
  timezone: 'Asia/Kolkata',
  chat: { dmUrl: 'https://chat.google.com/dm/AAAA' },
  standups: [
    { id: 1, name: 'Engineering', schedule: { promptTime: '09:30', deadlineTime: '23:59', timezone: 'Asia/Kolkata', days: ['mon', 'tue', 'wed', 'thu', 'fri'] }, today: 'waiting', progress: { submitted: 7, expected: 9 }, mandatory: true, onVacation: false },
    { id: 2, name: 'Product Weekly', schedule: { promptTime: '10:00', deadlineTime: '12:00', timezone: 'Asia/Kolkata', days: ['mon'] }, today: null, progress: null, mandatory: false, onVacation: false },
    { id: 3, name: 'Design', schedule: { promptTime: '10:00', deadlineTime: '12:00', timezone: 'Europe/Berlin', days: ['tue'] }, today: 'submitted', progress: { submitted: 3, expected: 3 }, mandatory: true, onVacation: false },
  ],
};
const SUBS = [
  { date: '2026-09-15', standupName: 'Engineering', submittedAt: 'x', editedAt: null, late: false, mood: 'good', answers: [{ question: 'Y', answer: 'Landed the SAML endpoint.' }, { question: 'T', answer: '' }, { question: 'B', answer: 'None' }] },
  { date: '2026-09-14', standupName: 'Engineering', submittedAt: 'x', editedAt: 'y', late: true, mood: 'good', answers: [] },
];

function server(over: Record<string, { status?: number; body: unknown }> = {}) {
  const patches: unknown[] = [];
  return {
    patches,
    ...stubApi({
      'GET /api/v1/me': { body: MEMBER },
      'GET /api/v1/me/standups': { body: MINE },
      'GET /api/v1/me/submissions?limit=5': { body: { submissions: SUBS } },
      'GET /api/v1/me/submissions?limit=50': { body: { submissions: [...SUBS, { ...SUBS[0], date: '2026-09-13' }] } },
      'PATCH /api/v1/me': { body: (init?: RequestInit) => { patches.push(JSON.parse(String(init?.body))); return { timezone: 'UTC', onVacation: false }; } },
      ...over,
    }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('member console', () => {
  it('greets, shows the open standup with a Chat link, my standups, answers and settings', async () => {
    const { patches } = server();
    renderApp('/me');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: /Good (morning|afternoon|evening), Bob/ })).toBeInTheDocument();
    expect(screen.getByText(/1 standup waiting for you/)).toBeInTheDocument();
    expect(screen.getByText('Engineering · today’s standup is open')).toBeInTheDocument();
    expect(screen.getByText(/7 of 9 teammates have already posted/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Answer in Chat ↗' })).toHaveAttribute('href', 'https://chat.google.com/dm/AAAA');
    expect(screen.getByText('Waiting for you')).toHaveClass('badge-warning');
    expect(screen.getByText('Submitted ✓')).toHaveClass('badge-success');
    expect(screen.getByText('Not today')).toBeInTheDocument();
    expect(screen.getByText('optional')).toBeInTheDocument();

    expect(await screen.findByText('Landed the SAML endpoint.')).toBeInTheDocument();
    expect(screen.getByText('Engineering · late · edited · 🙂')).toBeInTheDocument();
    expect(screen.getByText('Your recent answers: mostly 🙂')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('My timezone'), 'UTC');
    await waitFor(() => expect(patches).toContainEqual({ timezone: 'UTC' }));
    await user.click(screen.getByLabelText(/Vacation mode/));
    await waitFor(() => expect(patches).toContainEqual({ onVacation: true }));
  });

  it('pages answers, falls back to Chat home without a DM, and explains an unlinked account', async () => {
    server({
      'GET /api/v1/me/standups': { body: { ...MINE, chat: { dmUrl: null }, timezone: null } },
      'GET /api/v1/me/submissions?limit=5': { body: { submissions: [...SUBS, ...SUBS, ...SUBS].map((s, i) => ({ ...s, date: `2026-09-0${i + 1}` })) } },
    });
    renderApp('/me');
    const user = userEvent.setup();
    expect(await screen.findByRole('link', { name: 'Answer in Chat ↗' })).toHaveAttribute('href', 'https://chat.google.com/');
    await user.click(await screen.findByRole('button', { name: 'View all' }));
    await waitFor(() => expect(screen.getAllByText(/Engineering/).length).toBeGreaterThan(3));
    expect(screen.getByLabelText('My timezone')).toHaveValue('');

    vi.unstubAllGlobals();
    server({ 'GET /api/v1/me/standups': { body: { linked: false, standups: [] } }, 'GET /api/v1/me/submissions?limit=5': { body: { submissions: [] } } });
    renderApp('/me');
    expect(await screen.findByText('Your account is not linked to Google Chat yet')).toBeInTheDocument();
    expect(screen.getByText(/not linked to Chat yet/)).toBeInTheDocument();
    expect(screen.getByText(/No answers yet/)).toBeInTheDocument();
  });

  it('reports failures and a rejected save', async () => {
    server({ 'PATCH /api/v1/me': { status: 400, body: { error: { code: 'invalid', message: 'Invalid IANA timezone: Nope', field: 'timezone' } } } });
    renderApp('/me');
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('My timezone'), 'UTC');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid IANA timezone');

    vi.unstubAllGlobals();
    server({ 'GET /api/v1/me/standups': { status: 500, body: { error: { code: 'boom', message: 'db' } } } });
    renderApp('/me');
    expect(await screen.findByText(/Could not load your standups: db/)).toBeInTheDocument();
  });

  it('has pure helpers for the greeting and mood summary', () => {
    expect(greeting(8)).toBe('Good morning');
    expect(greeting(13)).toBe('Good afternoon');
    expect(greeting(20)).toBe('Good evening');
    expect(moodSummary([])).toBeNull();
    expect(moodSummary(['good', null, 'good', 'meh'])).toBe('mostly 🙂');
  });
});
