import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, MEMBER, renderApp, stubApi } from '../test/harness';

const ENG = { id: 1, name: 'Engineering', spaceName: 'spaces/A', active: true, schedule: { promptTime: '09:30', deadlineTime: '11:30', timezone: 'Asia/Kolkata', days: ['mon', 'tue', 'wed', 'thu', 'fri'], reminderMinutesBefore: 30 }, people: { total: 2, mandatory: 2 }, today: { date: '2026-09-18', status: 'open', submitted: 1, expected: 2, missing: [] }, permissions: { manage: true }, questions: ['Q1'], mood: { enabled: false, anonymous: false }, digestEnabled: false, timeOffPolicy: 'self', escalation: { afterDays: 2, contact: null }, webhook: { configured: false }, participants: [], admins: [] };
const PEOPLE = [
  { userName: 'users/1', displayName: 'Asha Verma', email: 'asha@x.dev', timezone: 'Asia/Kolkata', onVacation: false, workingDays: null, workingDaysLabel: 'Follows the standup', standups: [{ id: 1, name: 'Engineering', mandatory: true, admin: true }] },
  { userName: 'users/priya', displayName: 'Priya Sharma', email: null, timezone: null, onVacation: false, workingDays: 'mon,tue,wed,thu', workingDaysLabel: 'Mon–Thu', standups: [{ id: 1, name: 'Engineering', mandatory: true, admin: false }] },
];
const REQUESTS = [
  { id: 7, userName: 'users/priya', displayName: 'Priya Sharma', date: '2026-09-22', working: false, reason: 'sick', status: 'pending', label: 'Day off', setBy: 'Priya Sharma', channel: 'chat', decidedBy: null, decisionNote: null, createdAt: '2026-09-18T10:00:00Z' },
  { id: 8, userName: 'users/priya', displayName: 'Priya Sharma', date: '2026-09-23', working: false, reason: 'sick', status: 'pending', label: 'Day off', setBy: 'Priya Sharma', channel: 'chat', decidedBy: null, decisionNote: null, createdAt: '2026-09-18T10:00:00Z' },
];
const PRIYA_SCHEDULE = {
  userName: 'users/priya', displayName: 'Priya Sharma', workingDays: 'mon,tue,wed,thu', workingDaysLabel: 'Mon–Thu',
  policies: [{ standupId: 1, name: 'Engineering', timeOffPolicy: 'approval' }],
  overrides: [
    { id: 3, userName: 'users/priya', displayName: 'Priya Sharma', date: '2026-09-19', working: false, reason: 'comp off', status: 'active', label: 'Day off', setBy: 'Priya Sharma', channel: 'chat', decidedBy: null, decisionNote: null, createdAt: 'x' },
    { id: 4, userName: 'users/priya', displayName: 'Priya Sharma', date: '2026-09-27', working: true, reason: '', status: 'active', label: 'Working', setBy: 'Asha Verma', channel: 'console', decidedBy: null, decisionNote: null, createdAt: 'x' },
    { id: 5, userName: 'users/priya', displayName: 'Priya Sharma', date: '2026-09-30', working: false, reason: '', status: 'withdrawn', label: 'Day off', setBy: 'Priya Sharma', channel: 'chat', decidedBy: null, decisionNote: null, createdAt: 'x' },
  ],
};

function server(over: Record<string, { status?: number; body: unknown }> = {}, me: unknown = ADMIN) {
  const bodies: Record<string, unknown>[] = [];
  const record = (reply: unknown) => (init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body ?? '{}'))); return reply; };
  return {
    bodies,
    ...stubApi({
      'GET /api/v1/me': { body: me },
      'GET /api/v1/standups': { body: { standups: [ENG] } },
      'GET /api/v1/standups/1': { body: ENG },
      'GET /api/v1/people': { body: { people: PEOPLE } },
      'GET /api/v1/requests': { body: { requests: REQUESTS } },
      'GET /api/v1/people/users%2Fpriya/schedule': { body: PRIYA_SCHEDULE },
      'PATCH /api/v1/people/users%2Fpriya/schedule': { body: record({ ...PRIYA_SCHEDULE, workingDays: 'mon,tue,wed', workingDaysLabel: 'Mon–Wed' }) },
      'POST /api/v1/people/users%2Fpriya/overrides': { body: record({ ok: true, status: 'active', message: '🏖️ Sat 19 Sep marked off.' }) },
      'DELETE /api/v1/people/users%2Fpriya/overrides/2026-09-19': { body: { ok: true, message: '✅ Sat 19 Sep is back to Priya Sharma’s usual week.' } },
      'POST /api/v1/requests/7,8/approve': { body: record({ ok: true, message: '✅ Approved — Priya Sharma has been told.' }) },
      'POST /api/v1/requests/7,8/decline': { body: record({ ok: true, message: '❌ Declined — Priya Sharma has been told.' }) },
      'PATCH /api/v1/standups/1': { body: record({ ...ENG, timeOffPolicy: 'approval' }) },
      ...over,
    }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('team schedules', () => {
  it('shows each person’s week, opens the drawer, saves a week, adds and cancels overrides', async () => {
    const { bodies, calls } = server();
    renderApp('/team');
    const user = userEvent.setup();
    expect(await screen.findByText('Mon–Thu')).toBeInTheDocument();
    expect(screen.getByText('Standup days')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions for Priya Sharma' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit schedule…' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit schedule' });
    expect(await within(drawer).findByText('Priya Sharma · Engineering')).toBeInTheDocument();
    expect(within(drawer).getByRole('radio', { name: 'Custom week' })).toBeChecked();
    expect(within(drawer).getByRole('button', { name: 'Thu' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(drawer).getByRole('button', { name: 'Fri' })).toHaveAttribute('aria-pressed', 'false');
    // overrides list: withdrawn entries are hidden, others show their status
    expect(within(drawer).getByText('Sat 19 Sep')).toBeInTheDocument();
    expect(within(drawer).getByText('Sun 27 Sep')).toBeInTheDocument();
    expect(within(drawer).queryByText('Wed 30 Sep')).not.toBeInTheDocument();
    expect(within(drawer).getByText(/Time-off policy: Needs a manager/)).toBeInTheDocument();

    // untoggle Thursday and save the week
    await user.click(within(drawer).getByRole('button', { name: 'Thu' }));
    await user.click(within(drawer).getByRole('button', { name: 'Save week' }));
    await waitFor(() => expect(bodies).toContainEqual({ workingDays: 'mon,tue,wed' }));

    // switch to ad hoc then revert without saving
    await user.click(within(drawer).getByRole('radio', { name: /Ad hoc/ }));
    await user.click(within(drawer).getByRole('button', { name: 'Revert' }));
    expect(within(drawer).getByRole('radio', { name: 'Custom week' })).toBeChecked();

    // add a range, mark away today, cancel one
    await user.type(within(drawer).getByLabelText('From date'), '2026-10-05');
    await user.type(within(drawer).getByLabelText('To date'), '2026-10-06');
    await user.selectOptions(within(drawer).getByLabelText('Off or working'), 'working');
    await user.type(within(drawer).getByLabelText('Reason'), 'release');
    await user.click(within(drawer).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(bodies).toContainEqual({ from: '2026-10-05', to: '2026-10-06', working: true, reason: 'release' }));
    expect(await within(drawer).findByRole('status')).toHaveTextContent('marked off');
    await user.click(within(drawer).getByRole('button', { name: 'Mark away today' }));
    await waitFor(() => expect(bodies.some((b) => b.working === false && typeof b.date === 'string')).toBe(true));
    await user.click(within(drawer).getByRole('button', { name: 'Cancel Sat 19 Sep' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/v1/people/users%2Fpriya/overrides/2026-09-19'));
    await user.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('surfaces refusals from the drawer and a failed schedule load', async () => {
    server({
      'PATCH /api/v1/people/users%2Fpriya/schedule': { status: 400, body: { error: { code: 'invalid', message: 'Only your managers can change your schedule here.' } } },
    });
    renderApp('/team');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Priya Sharma' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit schedule…' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit schedule' });
    await user.click(await within(drawer).findByRole('radio', { name: /Follow the standup/ }));
    await user.click(within(drawer).getByRole('button', { name: 'Save week' }));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('Only your managers');
    await user.click(within(drawer).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reports a failed schedule load in the drawer', async () => {
    server({ 'GET /api/v1/people/users%2Fpriya/schedule': { status: 500, body: { error: { code: 'boom', message: 'Database away.' } } } });
    renderApp('/team');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Priya Sharma' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit schedule…' }));
    expect(await screen.findByText(/Could not load the schedule/)).toBeInTheDocument();
  });

  it('lists pending requests and approves or declines them with a note', async () => {
    const { bodies, calls } = server();
    renderApp('/team');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Requests · 1' }));
    expect(screen.getByText('Tue 22 Sep – Wed 23 Sep · 2 days off')).toBeInTheDocument();
    expect(screen.getByText(/“sick” · requested via chat/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Decline…' }));
    await user.type(screen.getByLabelText('Reason for declining'), 'not this week');
    await user.click(screen.getByRole('button', { name: 'Send decline' }));
    await waitFor(() => expect(bodies).toContainEqual({ note: 'not this week' }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls).toContain('POST /api/v1/requests/7,8/approve'));
  });

  it('explains an empty queue', async () => {
    server({ 'GET /api/v1/requests': { body: { requests: [] } } });
    renderApp('/team');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Requests · 0' }));
    expect(screen.getByText(/No time-off requests waiting/)).toBeInTheDocument();
  });

  it('reports a failed requests load', async () => {
    server({ 'GET /api/v1/requests': { status: 500, body: { error: { code: 'boom', message: 'Database away.' } } } });
    renderApp('/team');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Requests · 0' }));
    expect(await screen.findByText(/Could not load requests/)).toBeInTheDocument();
  });
});

describe('standup time-off policy', () => {
  it('saves the policy from the schedule settings', async () => {
    const { bodies } = server();
    renderApp('/standups/1/settings');
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Time-off policy'), 'approval');
    await waitFor(() => expect(bodies).toContainEqual({ timeOffPolicy: 'approval' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Time-off policy saved');
  });
});

describe('my schedule', () => {
  const MINE = { linked: true, timezone: null, chat: { dmUrl: null }, standups: [{ id: 1, name: 'Engineering', schedule: { promptTime: '09:30', deadlineTime: '11:30', timezone: 'Asia/Kolkata', days: ['mon'] }, today: null, progress: null, mandatory: true, onVacation: false }] };
  const MY_SCHEDULE = { ...PRIYA_SCHEDULE, userName: 'users/2', displayName: 'Bob', policies: [{ standupId: 1, name: 'Engineering', timeOffPolicy: 'self' }], overrides: [{ ...PRIYA_SCHEDULE.overrides[0]!, userName: 'users/2', displayName: 'Bob' }, { ...PRIYA_SCHEDULE.overrides[1]!, status: 'pending', userName: 'users/2', displayName: 'Bob' }] };
  function mine(over: Record<string, { status?: number; body: unknown }> = {}) {
    return server({
      'GET /api/v1/me/standups': { body: MINE },
      'GET /api/v1/me/submissions?limit=5': { body: { submissions: [] } },
      'GET /api/v1/me/schedule': { body: MY_SCHEDULE },
      'POST /api/v1/me/overrides': { body: (init?: RequestInit) => ({ ok: true, status: 'active', message: `🏖️ ${JSON.parse(String(init?.body)).date} marked off.` }) },
      ...over,
    }, MEMBER);
  }

  it('shows the week, upcoming days off, quick actions and the drawer', async () => {
    const { calls } = mine();
    renderApp('/me');
    const user = userEvent.setup();
    expect(await screen.findByText('Working days · Mon–Thu')).toBeInTheDocument();
    const week = screen.getByLabelText('My working days');
    expect(within(week).getByText('Mon')).toHaveAttribute('aria-pressed', 'true');
    expect(within(week).getByText('Sat')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('awaiting a manager')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Off tomorrow' }));
    expect(await screen.findByRole('status')).toHaveTextContent('marked off');
    expect(calls.filter((c) => c === 'POST /api/v1/me/overrides')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Off today' }));
    await waitFor(() => expect(calls.filter((c) => c === 'POST /api/v1/me/overrides')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const drawer = await screen.findByRole('dialog', { name: 'My schedule' });
    expect(await within(drawer).findByText(/Past days can only be changed by a manager/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Close' }));
  });

  it('reports a refused quick action', async () => {
    mine({ 'POST /api/v1/me/overrides': { status: 403, body: { error: { code: 'refused', message: 'Only your managers can mark you away here.' } } } });
    renderApp('/me');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Off today' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only your managers');
  });

  it('reports a failed schedule load', async () => {
    mine({ 'GET /api/v1/me/schedule': { status: 500, body: { error: { code: 'boom', message: 'Database away.' } } } });
    renderApp('/me');
    expect(await screen.findByText(/Could not load your schedule/)).toBeInTheDocument();
  });
});
