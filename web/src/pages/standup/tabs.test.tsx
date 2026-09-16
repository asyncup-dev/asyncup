import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, renderApp, stubApi } from '../../test/harness';

const ENG = {
  id: 1, name: 'Engineering', spaceName: 'spaces/A', active: true,
  schedule: { promptTime: '09:30', deadlineTime: '11:30', timezone: 'Asia/Kolkata', days: ['mon', 'tue'], reminderMinutesBefore: 30 },
  questions: ['Q1?', 'Q2?'], mood: { enabled: true, anonymous: false }, digestEnabled: false,
  escalation: { afterDays: 2, contact: null }, webhook: { configured: true },
  people: { total: 2, mandatory: 1 },
  today: { date: '2026-09-16', status: 'closed', submitted: 2, expected: 2, missing: [] },
  permissions: { manage: true },
  participants: [
    { userName: 'users/alice', displayName: 'Alice', mandatory: true, timezone: null, onVacation: false },
    { userName: 'users/bob', displayName: 'Bob', mandatory: false, timezone: 'Europe/Berlin', onVacation: true },
  ],
  admins: [{ userName: 'users/alice', displayName: 'Alice' }],
};
const RUNS = [
  { date: '2026-09-16', status: 'closed', submitted: 2, expected: 2, missing: [] },
  { date: '2026-09-15', status: 'closed', submitted: 1, expected: 2, missing: [{ userName: 'users/bob', displayName: 'Bob' }] },
  { date: '2026-09-14', status: 'open', submitted: 0, expected: 2, missing: [] },
];
const detail = (date: string, late: boolean) => ({ date, status: 'closed', submitted: 2, expected: 2, missing: [], teamMood: null, submissions: [{ userName: 'users/alice', displayName: 'Alice', submittedAt: 'x', editedAt: null, late, mood: null, answers: [] }] });
const WEEKS = Array.from({ length: 16 }, (_, i) => ({ label: `w${i}`, participationPct: 80, mood: i > 8 ? 4 : null, blockersOpened: 1, blockersResolved: 1 }));

function server(over: Record<string, { status?: number; body: unknown }> = {}) {
  const patches: Record<string, unknown>[] = [];
  return {
    patches,
    ...stubApi({
      'GET /api/v1/me': { body: ADMIN },
      'GET /api/v1/standups/1': { body: ENG },
      'GET /api/v1/spaces': { body: { spaces: [] } },
      'PATCH /api/v1/standups/1': { body: (init?: RequestInit) => { patches.push(JSON.parse(String(init?.body))); return ENG; } },
      'POST /api/v1/standups/1/archive': { body: {} },
      'PATCH /api/v1/standups/1/participants/users%2Fbob': { body: {} },
      'DELETE /api/v1/standups/1/participants/users%2Fbob': { status: 204, body: null },
      'POST /api/v1/standups/1/participants': { status: 201, body: { reachable: true } },
      'GET /api/v1/spaces/spaces%2FA/members': { body: { members: [{ userName: 'users/alice', displayName: 'Alice' }, { userName: 'users/carol', displayName: 'Carol' }] } },
      'POST /api/v1/verify/webhook': { body: { state: 'pass', detail: 'Webhook answered 204.', checkedAt: 'x' } },
      'GET /api/v1/standups/1/insights?weeks=16': { body: { weeks: WEEKS } },
      'GET /api/v1/standups/1/runs?limit=40': { body: { runs: RUNS } },
      'GET /api/v1/standups/1/runs/2026-09-16': { body: detail('2026-09-16', true) },
      'GET /api/v1/standups/1/runs/2026-09-15': { body: detail('2026-09-15', false) },
      ...over,
    }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('standup settings tab', () => {
  it('saves schedule, questions, mood, escalation, webhook and digest', async () => {
    const { patches, calls } = server();
    renderApp('/standups/1/settings');
    const user = userEvent.setup();
    expect(await screen.findByLabelText('Prompt time')).toHaveValue('09:30');
    await user.click(screen.getByRole('button', { name: 'Wed' }));
    await user.clear(screen.getByLabelText('Reminder minutes'));
    await user.type(screen.getByLabelText('Reminder minutes'), '45');
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]!);
    await waitFor(() => expect(patches[0]).toEqual({ promptTime: '09:30', deadlineTime: '11:30', timezone: 'Asia/Kolkata', days: ['mon', 'tue', 'wed'], reminderMinutesBefore: 45 }));
    expect(await screen.findByRole('status')).toHaveTextContent('Schedule saved');

    await user.click(screen.getByRole('button', { name: '+ Add question' }));
    await user.type(screen.getByLabelText('Question 3'), 'Q3?');
    await user.click(screen.getByRole('button', { name: 'Move question 3 up' }));
    await user.click(screen.getByRole('button', { name: 'Remove question 1' }));
    await user.click(screen.getAllByRole('button', { name: 'Save' })[1]!);
    await waitFor(() => expect(patches.at(-1)).toEqual({ questions: ['Q3?', 'Q2?'] }));
    await user.click(screen.getByLabelText('answers shown anonymously'));
    await waitFor(() => expect(patches.at(-1)).toEqual({ moodAnonymous: true }));

    await user.selectOptions(screen.getByLabelText('Escalation contact'), 'users/bob');
    await user.click(screen.getAllByRole('button', { name: 'Save' })[2]!);
    await waitFor(() => expect(patches.at(-1)).toEqual({ escalateAfterDays: 2, escalateUserName: 'users/bob' }));

    await user.click(screen.getByLabelText('Webhook URL'));
    await user.type(screen.getByLabelText('Webhook URL'), 'https://hooks.example/x');
    await user.click(screen.getAllByRole('button', { name: 'Save' })[3]!);
    await waitFor(() => expect(patches.at(-1)).toEqual({ webhookUrl: 'https://hooks.example/x' }));
    await user.click(screen.getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText(/Webhook answered 204/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('checkbox').at(-1)!);
    await waitFor(() => expect(patches.at(-1)).toEqual({ digestEnabled: true }));
    expect(calls).toContain('POST /api/v1/verify/webhook');
  });

  it('manages the roster and archives behind a typed confirmation', async () => {
    const { calls } = server();
    renderApp('/standups/1/settings');
    const user = userEvent.setup();
    expect(await screen.findByText('Participants · 2')).toBeInTheDocument();
    expect(screen.getByText('Manager')).toBeInTheDocument();
    expect(screen.getByText('Optional')).toHaveClass('badge-warning');
    await user.click(screen.getByRole('button', { name: 'Make mandatory' }));
    await waitFor(() => expect(calls).toContain('PATCH /api/v1/standups/1/participants/users%2Fbob'));
    await user.click(screen.getByRole('button', { name: 'Add people' }));
    await user.click(await screen.findByRole('button', { name: '+ Carol' }));
    await waitFor(() => expect(calls).toContain('POST /api/v1/standups/1/participants'));
    await user.click(screen.getByRole('button', { name: 'Remove Bob' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/v1/standups/1/participants/users%2Fbob'));

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'ARCHIVE');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(calls).toContain('POST /api/v1/standups/1/archive'));
  });

  it('surfaces a rejected save', async () => {
    server({ 'PATCH /api/v1/standups/1': { status: 400, body: { error: { code: 'invalid', message: 'Prompt time must be before the deadline.', field: 'promptTime' } } } });
    renderApp('/standups/1/settings');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'Save' }))[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Prompt time must be before the deadline.');
  });
});

describe('standup insights tab', () => {
  it('shows the stats, per-person participation and charts', async () => {
    server();
    renderApp('/standups/1/insights');
    expect(await screen.findByText('Participation by person')).toBeInTheDocument();
    expect(await screen.findByText('2 closed runs')).toBeInTheDocument();
    expect(await screen.findByText('Every run')).toBeInTheDocument();
    expect(screen.getByText('away')).toBeInTheDocument();
    expect((await screen.findAllByText('50%'))[0]).toBeInTheDocument();
    expect(screen.getByText('1 of 2 in the last 2 runs')).toBeInTheDocument();
    expect(screen.getByText('4 / 5')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Weekly average mood on a 1 to 5 scale' })).toBeInTheDocument();
    expect(screen.getAllByText('80%').length).toBeGreaterThan(0);
  });
});
