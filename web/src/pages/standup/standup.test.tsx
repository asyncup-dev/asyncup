import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, MEMBER, OPERATOR, renderApp, stubApi } from '../../test/harness';
import { participation, todayBadge } from '../standups';

const ENG = {
  id: 1,
  name: 'Engineering',
  spaceName: 'spaces/AAAA',
  active: true,
  schedule: { promptTime: '09:30', deadlineTime: '11:30', timezone: 'Asia/Kolkata', days: ['mon', 'tue', 'wed', 'thu', 'fri'], reminderMinutesBefore: 30 },
  questions: ['What did you do yesterday?', 'What will you do today?', 'Any blockers?'],
  mood: { enabled: true, anonymous: false },
  digestEnabled: true,
  escalation: { afterDays: 2, contact: { userName: 'users/priya', displayName: 'Priya Sharma' } },
  webhook: { configured: false },
  people: { total: 9, mandatory: 8 },
  today: { date: '2026-09-16', status: 'open', submitted: 7, expected: 9, missing: [{ userName: 'users/asha', displayName: 'Asha Verma' }, { userName: 'users/rohit', displayName: 'Rohit Kumar' }] },
  permissions: { manage: true },
  participants: [],
  admins: [],
};
const DESIGN = { ...ENG, id: 2, name: 'Design', spaceName: 'spaces/BBBB', people: { total: 5, mandatory: 5 }, today: { date: '2026-09-16', status: 'closed', submitted: 5, expected: 5, missing: [] } };
const WEEKLY = { ...ENG, id: 3, name: 'Product Weekly', today: { date: '2026-09-16', status: null, submitted: 0, expected: 0, missing: [] }, permissions: { manage: false } };

const TODAY = {
  date: '2026-09-16',
  status: 'open',
  expected: 9,
  submitted: [
    { userName: 'users/alice', displayName: 'Alice Rao', submittedAt: '2026-09-16T04:11:00Z', late: false, mood: 'great' },
    { userName: 'users/jun', displayName: 'Jun Tanaka', submittedAt: '2026-09-16T05:17:00Z', late: true, mood: 'meh' },
  ],
  waiting: [{ userName: 'users/asha', displayName: 'Asha Verma', mandatory: true, remindedAt: null }, { userName: 'users/rohit', displayName: 'Rohit Kumar', mandatory: false, remindedAt: '2026-09-16T05:00:00Z' }],
  away: [{ userName: 'users/dev', displayName: 'Dev Patel', reason: 'vacation' }],
  teamMood: null,
};
const RUNS = [
  { date: '2026-09-16', status: 'open', submitted: 7, expected: 9, missing: [{ userName: 'users/asha', displayName: 'Asha' }] },
  { date: '2026-09-15', status: 'closed', submitted: 9, expected: 9, missing: [] },
  { date: '2026-09-14', status: 'closed', submitted: 8, expected: 9, missing: [{ userName: 'users/dev', displayName: 'Dev Patel' }] },
];
const RUN_15 = {
  date: '2026-09-15',
  status: 'closed',
  submitted: 9,
  expected: 9,
  missing: [],
  teamMood: 4.2,
  submissions: Array.from({ length: 7 }, (_, i) => ({
    userName: `users/p${i}`,
    displayName: i === 0 ? 'Alice Rao' : `Person ${i}`,
    submittedAt: '2026-09-15T04:11:00Z',
    editedAt: i === 1 ? '2026-09-15T05:00:00Z' : null,
    late: i === 2,
    mood: i === 0 ? 'good' : null,
    answers: [
      { question: 'What did you do yesterday?', answer: 'Landed the SAML metadata endpoint.' },
      { question: 'What will you do today?', answer: '' },
      { question: 'Any blockers?', answer: 'None' },
    ],
  })),
};
const BLOCKERS = [
  { id: 11, standup: { id: 1, name: 'Engineering' }, owner: { userName: 'users/bob', displayName: 'Bob Mehta' }, text: 'Waiting on API keys from the platform team', openedDate: '2026-09-13', resolvedDate: null, resolvedBy: null, escalatedAt: '2026-09-15T10:00:00Z', status: 'open', tags: [{ userName: 'users/1', displayName: 'Asha', acknowledgedAt: null }], updates: [] },
  { id: 12, standup: { id: 1, name: 'Engineering' }, owner: { userName: 'users/carol', displayName: 'Carol Chen' }, text: 'CI runners are saturated', openedDate: '2026-09-16', resolvedDate: null, resolvedBy: null, escalatedAt: null, status: 'acknowledged', tags: [], updates: [] },
];

function server(over: Record<string, { status?: number; body: unknown }> = {}, me: unknown = ADMIN) {
  return stubApi({
    'GET /api/v1/me': { body: me },
    'GET /api/v1/standups': { body: { standups: [ENG, DESIGN, WEEKLY] } },
    'GET /api/v1/spaces': { body: { spaces: [{ name: 'spaces/AAAA', displayName: 'platform-hq', standups: [] }] } },
    'GET /api/v1/blockers?status=open': { body: { blockers: BLOCKERS } },
    'GET /api/v1/blockers?status=open&standupId=1': { body: { blockers: BLOCKERS } },
    'GET /api/v1/standups/1/insights?weeks=2': { body: { weeks: [{ label: 'a', participationPct: 80, mood: null, blockersOpened: 0, blockersResolved: 0 }, { label: 'b', participationPct: 90, mood: null, blockersOpened: 0, blockersResolved: 0 }] } },
    'GET /api/v1/standups/2/insights?weeks=2': { body: { weeks: [{ label: 'a', participationPct: 100, mood: null, blockersOpened: 0, blockersResolved: 0 }, { label: 'b', participationPct: 80, mood: null, blockersOpened: 0, blockersResolved: 0 }] } },
    'GET /api/v1/standups/3/insights?weeks=2': { body: { weeks: [{ label: 'a', participationPct: null, mood: null, blockersOpened: 0, blockersResolved: 0 }, { label: 'b', participationPct: null, mood: null, blockersOpened: 0, blockersResolved: 0 }] } },
    'GET /api/v1/standups/1': { body: ENG },
    'GET /api/v1/standups/1/runs/today': { body: TODAY },
    'GET /api/v1/standups/1/runs?limit=5': { body: { runs: RUNS } },
    'GET /api/v1/standups/1/runs?limit=90': { body: { runs: RUNS } },
    'GET /api/v1/standups/1/runs/2026-09-16': { body: { ...RUN_15, date: '2026-09-16', status: 'open', submitted: 7, missing: [{ userName: 'users/asha', displayName: 'Asha' }], teamMood: null, submissions: RUN_15.submissions.slice(0, 2) } },
    'GET /api/v1/standups/1/runs/2026-09-15': { body: RUN_15 },
    'GET /api/v1/standups/1/runs/2026-09-14': { status: 404, body: { error: { code: 'not_found', message: 'No run on that date.' } } },
    'POST /api/v1/standups/1/run-now': { body: { result: 'already_open' } },
    'POST /api/v1/standups/1/nudge': { body: { result: 'sent' } },
    'POST /api/v1/blockers/11/acknowledge': { body: { result: 'acked' } },
    'POST /api/v1/blockers/12/resolve': { status: 403, body: { error: { code: 'not_allowed', message: 'Only the owner, tagged people and standup admins can resolve a blocker.' } } },
    'GET /api/v1/standups/3': { body: WEEKLY },
    'GET /api/v1/standups/3/runs/today': { body: { date: '2026-09-16', status: null, expected: 0, submitted: [], waiting: [], away: [], teamMood: null } },
    'GET /api/v1/standups/3/runs?limit=5': { body: { runs: [] } },
    'GET /api/v1/blockers?status=open&standupId=3': { body: { blockers: [] } },
    'GET /api/v1/standups/9': { status: 404, body: { error: { code: 'not_found', message: 'No such standup.' } } },
    ...over,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('standups home', () => {
  it('shows the stats strip and the table with space names', async () => {
    server();
    renderApp('/standups');
    expect(await screen.findByText('Wed 16 Sept · 3 standups · 1 open today')).toBeInTheDocument();
    expect(await screen.findByText('12 / 14')).toBeInTheDocument();
    expect(screen.getByText('2 still waiting')).toBeInTheDocument();
    expect(await screen.findByText('85%')).toBeInTheDocument();
    expect(screen.getByText('↓ 5 pts vs last week')).toBeInTheDocument();
    expect(await screen.findByText('1 escalated')).toBeInTheDocument();
    expect(screen.getByText('Asha, Rohit')).toBeInTheDocument();
    expect(await screen.findAllByText('#platform-hq')).toHaveLength(2);
    expect(screen.getByText('spaces/BBBB')).toBeInTheDocument();
    expect(screen.getByText('7 / 9 in')).toHaveClass('badge-warning');
    expect(screen.getByText('Wrapped up')).toHaveClass('badge-success');
    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Engineering/ })).toHaveAttribute('href', '/app/standups/1');
    expect(screen.getByRole('link', { name: 'New standup' })).toHaveAttribute('href', '/app/setup/template');
  });

  it('degrades when spaces and blockers are unavailable', async () => {
    server({ 'GET /api/v1/spaces': { status: 403, body: { error: { code: 'forbidden', message: 'Admins only.' } } }, 'GET /api/v1/blockers?status=open': { status: 500, body: { error: { code: 'boom', message: 'db' } } } });
    renderApp('/standups');
    expect(await screen.findAllByText('spaces/AAAA')).toHaveLength(2);
    expect(await screen.findByText('Could not load')).toBeInTheDocument();
    expect(todayBadge({ ...ENG, today: { ...ENG.today, missing: [] } } as never).tone).toBe('badge-success');
    expect(participation([undefined, [{ label: 'x', participationPct: 50, mood: null, blockersOpened: 0, blockersResolved: 0 }]])).toEqual({ now: 50, delta: null });
    expect(participation([])).toEqual({ now: null, delta: null });
  });
});

describe('standup overview', () => {
  it('renders the header, today’s run, recent runs, blockers and schedule', async () => {
    const { calls } = server();
    renderApp('/standups/1');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Engineering' })).toBeInTheDocument();
    expect(screen.getByText('Run open · 7 / 9 in')).toBeInTheDocument();
    expect(await screen.findByText(/#platform-hq · 09:30 – 11:30/)).toBeInTheDocument();
    expect(screen.getByText(/Mon–Fri · 9 participants/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');

    expect(await screen.findByRole('img', { name: '2 of 9 submitted' })).toBeInTheDocument();
    expect(screen.getByText(/Live · updated/)).toBeInTheDocument();
    expect(screen.getByText('😄 09:41')).toBeInTheDocument();
    expect(screen.getByText('😕 10:47 · late')).toBeInTheDocument();
    expect(screen.getByText('reminded')).toBeInTheDocument();
    expect(screen.getByText('on vacation')).toBeInTheDocument();
    expect(await screen.findByText('Tue 15 Sept')).toBeInTheDocument();
    expect(screen.getByText('1 missing')).toHaveClass('badge-warning');
    expect(screen.getByText('Complete')).toHaveClass('badge-success');
    expect(screen.getByRole('link', { name: 'View history →' })).toHaveAttribute('href', '/app/standups/1/history');

    expect(await screen.findByText('Waiting on API keys from the platform team')).toBeInTheDocument();
    expect(screen.getByText('Escalated')).toHaveClass('badge-danger');
    expect(screen.getByText('Acknowledged')).toHaveClass('badge-info');
    expect(screen.getByText('After 2 days → Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('30 min before deadline')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(calls).toContain('POST /api/v1/blockers/11/acknowledge'));
    await user.click(screen.getAllByRole('button', { name: 'Resolve' })[1]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the owner');

    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByRole('status')).toHaveTextContent('already open');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await user.click(screen.getByRole('button', { name: 'Nudge everyone' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Reminder sent');
    expect(screen.getByRole('link', { name: 'Export CSV' })).toHaveAttribute('href', '/api/v1/standups/1/export.csv?days=90');
  });

  it('hides management actions from members, shows the idle state, and reports a missing standup', async () => {
    server({}, MEMBER);
    renderApp('/standups/3');
    expect(await screen.findByRole('heading', { name: 'Product Weekly' })).toBeInTheDocument();
    expect(screen.getByText('Next run on schedule')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
    expect(await screen.findByText(/No run today/)).toBeInTheDocument();
    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    expect(await screen.findByText('None open')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();

    cleanup();
    server({}, OPERATOR);
    renderApp('/standups/1');
    expect(await screen.findByText('Waiting on API keys from the platform team')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run now' })).toBeInTheDocument());
    server({ 'POST /api/v1/standups/1/run-now': { status: 409, body: { error: { code: 'no_open_run', message: 'Nope.' } } } }, OPERATOR);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Nope.');

    cleanup();
    server();
    renderApp('/standups/9');
    expect(await screen.findByText(/Could not load this standup: No such standup/)).toBeInTheDocument();
  });
});

describe('standup history', () => {
  it('lists runs, filters, opens a run and pages through submissions', async () => {
    server();
    renderApp('/standups/1/history');
    const user = userEvent.setup();
    expect(await screen.findByText('Runs · September')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'History' })).toHaveAttribute('aria-current', 'page');
    const rows = await screen.findAllByRole('button', { name: /Sept/ });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(await screen.findByText('Wednesday 16 September')).toBeInTheDocument();
    expect(screen.getByText(/still open · missing Asha/)).toBeInTheDocument();

    await user.click(rows[1]!);
    expect(await screen.findByText('Tuesday 15 September')).toBeInTheDocument();
    expect(screen.getByText(/9 of 9 submitted · closed · wrap-up posted · team mood 4.2\/5/)).toBeInTheDocument();
    expect(screen.getByText('🙂 09:41')).toBeInTheDocument();
    expect(screen.getByText('09:41 · edited')).toBeInTheDocument();
    expect(screen.getByText('09:41 · late')).toBeInTheDocument();
    expect(screen.getAllByText('Yesterday')).toHaveLength(5);
    expect(screen.getAllByText('—')).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Show 2 more submissions' }));
    expect(screen.getAllByText('Yesterday')).toHaveLength(7);
    expect(screen.getAllByRole('link', { name: 'Export CSV' })[1]).toHaveAttribute('href', '/api/v1/standups/1/export.csv?days=90');

    await user.click(rows[2]!);
    expect(await screen.findByText(/Could not load that run: No run on that date/)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox'), 'incomplete');
    expect(screen.getAllByRole('button', { name: /Sept/ })).toHaveLength(2);
    expect(within(screen.getAllByRole('button', { name: /Sept/ })[0]!).getByText('Open')).toBeInTheDocument();
    expect(within(screen.getAllByRole('button', { name: /Sept/ })[1]!).getByText('1 missing')).toBeInTheDocument();
  });

  it('handles a standup with no runs', async () => {
    server({ 'GET /api/v1/standups/1/runs?limit=90': { body: { runs: [] } } });
    renderApp('/standups/1/history');
    expect(await screen.findByText('No runs to show.')).toBeInTheDocument();
    expect(screen.getByText('Pick a run to see its answers.')).toBeInTheDocument();
  });
});
