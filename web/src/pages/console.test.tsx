import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsView } from '../lib/settings';
import { ADMIN, MEMBER, OPERATOR, renderApp, stubApi } from '../test/harness';
import { headline } from './reports';

const STANDUP = { id: 1, name: 'Engineering', spaceName: 'spaces/A', active: true, schedule: { promptTime: '09:30', deadlineTime: '11:30', timezone: 'Asia/Kolkata', days: ['mon'], reminderMinutesBefore: 60 }, people: { total: 2, mandatory: 2 }, today: { date: '2026-09-16', status: 'open', submitted: 1, expected: 2, missing: [] }, permissions: { manage: true } };
const B = (id: number, over: Record<string, unknown> = {}) => ({ id, standup: { id: 1, name: 'Engineering' }, owner: { userName: 'users/bob', displayName: 'Bob Mehta' }, text: `Blocker ${id}`, openedDate: '2026-09-13', resolvedDate: null, resolvedBy: null, escalatedAt: null, status: 'open', tags: [], updates: [], ...over });
const BLOCKERS = [
  B(11, { text: 'Waiting on API keys', escalatedAt: '2026-09-15T00:00:00Z', tags: [{ userName: 'users/1', displayName: 'Asha', acknowledgedAt: null }] }),
  B(12, { text: 'CI saturated', status: 'acknowledged', owner: { userName: 'users/carol', displayName: 'Carol Chen' }, updates: [{ userName: 'users/carol', displayName: 'Carol Chen', text: 'Talking to infra', at: '2026-09-15T10:00:00Z' }] }),
  B(13, { text: 'Old one', status: 'resolved', resolvedDate: '2026-09-10', openedDate: '2026-09-01' }),
];
const WEEKS = Array.from({ length: 16 }, (_, i) => ({ label: `w${i}`, participationPct: i < 8 ? 70 : 90, mood: 4, blockersOpened: 1, blockersResolved: i % 2 }));
const PEOPLE = [
  { userName: 'users/1', displayName: 'Asha Verma', email: 'asha@x.dev', timezone: 'Asia/Kolkata', onVacation: false, standups: [{ id: 1, name: 'Engineering', mandatory: true, admin: true }] },
  { userName: 'users/bob', displayName: 'Bob Mehta', email: null, timezone: null, onVacation: true, standups: [{ id: 1, name: 'Engineering', mandatory: false, admin: false }] },
];
function settingsFixture(): SettingsView {
  return {
    chat: { audience: '728449131907 https://x/chat/events', serviceAccount: { set: true, email: 'bot@x.iam', clientId: '104928' } },
    workspace: { defaultTimezone: 'Asia/Kolkata', calendarOoo: true, workspaceAdminEmail: '' },
    signIn: { tokenSignIn: true, google: { clientId: '', clientSecret: { set: false }, on: false }, saml: { entityId: 'https://idp', ssoUrl: 'https://idp/sso', cert: { set: true }, adminAttribute: '', adminGroup: '', on: true } },
    tokens: { tick: { set: false }, export: { set: true }, scim: { set: false } },
    setup: { complete: true, chatConfigured: true, signInConfigured: true },
    mcp: { enabled: false, defaultScopes: ['read'], endpoint: '/mcp', scopes: { read: 'Read things', 'blockers:write': 'Work blockers', submit: 'Submit answers' } },
  };
}

function server(over: Record<string, { status?: number; body: unknown }> = {}, me: unknown = ADMIN) {
  const settings = settingsFixture();
  const patches: Record<string, unknown>[] = [];
  const parse = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  return {
    settings,
    patches,
    ...stubApi({
      'GET /api/v1/me': { body: me },
      'GET /api/v1/standups': { body: { standups: [STANDUP] } },
      'GET /api/v1/blockers?status=all': { body: { blockers: BLOCKERS } },
      'GET /api/v1/blockers?status=open': { body: { blockers: BLOCKERS.filter((b) => b.status === 'open') } },
      'GET /api/v1/blockers?status=acknowledged': { body: { blockers: BLOCKERS.filter((b) => b.status === 'acknowledged') } },
      'GET /api/v1/blockers?status=resolved': { body: { blockers: BLOCKERS.filter((b) => b.status === 'resolved') } },
      'GET /api/v1/blockers?status=open&standupId=1': { body: { blockers: BLOCKERS.filter((b) => b.status === 'open') } },
      'GET /api/v1/blockers?status=open&owner=users%2Fcarol': { body: { blockers: [] } },
      'POST /api/v1/blockers/11/acknowledge': { body: { result: 'acked' } },
      'POST /api/v1/blockers/11/resolve': { status: 403, body: { error: { code: 'not_allowed', message: 'Only the owner, tagged people and standup admins can resolve a blocker.' } } },
      'POST /api/v1/blockers/12/update': { body: { result: 'ok' } },
      'GET /api/v1/standups/1/insights?weeks=16': { body: { weeks: WEEKS } },
      'GET /api/v1/standups/1/insights?weeks=8': { body: { weeks: WEEKS.slice(8) } },
      'GET /api/v1/people': { body: { people: PEOPLE } },
      'PATCH /api/v1/standups/1/participants/users%2Fbob': { body: {} },
      'PATCH /api/v1/standups/1/participants/users%2F1': { status: 409, body: { error: { code: 'last_admin', message: 'That would leave the standup without an admin.' } } },
      'DELETE /api/v1/standups/1/participants/users%2Fbob': { status: 204, body: null },
      'GET /api/v1/settings': { body: () => settings },
      'PATCH /api/v1/settings': {
        body: (init?: RequestInit) => {
          const p = parse(init);
          patches.push(p);
          if (p.tokenSignIn === false) throw Object.assign(new Error('lockout'), { forced: true });
          if (typeof p.defaultTimezone === 'string') settings.workspace.defaultTimezone = p.defaultTimezone;
          if (typeof p.calendarOoo === 'boolean') settings.workspace.calendarOoo = p.calendarOoo;
          if (typeof p.mcpEnabled === 'boolean') settings.mcp.enabled = p.mcpEnabled;
          if (typeof p.mcpDefaultScopes === 'string') settings.mcp.defaultScopes = p.mcpDefaultScopes.split(',').filter(Boolean);
          if (typeof p.oauthClientId === 'string') settings.signIn.google = { clientId: p.oauthClientId, clientSecret: { set: !!p.oauthClientId }, on: !!p.oauthClientId };
          if (typeof p.workspaceAdminEmail === 'string') settings.workspace.workspaceAdminEmail = p.workspaceAdminEmail;
          if (p.serviceAccountJson === null) settings.chat.serviceAccount = { set: false, email: null, clientId: null };
          if (typeof p.chatAudience === 'string') settings.chat.audience = p.chatAudience;
          return settings;
        },
      },
      'POST /api/v1/verify/project': { body: { state: 'pass', detail: 'Audience looks right.', checkedAt: 'x' } },
      'POST /api/v1/verify/service-account': { body: { state: 'pass', detail: 'Key verified for bot@x.iam.', checkedAt: 'x' } },
      'POST /api/v1/verify/chat-event': { body: { state: 'fail', detail: 'No event received yet.', checkedAt: 'x' } },
      'POST /api/v1/verify/dm': { body: { state: 'pass', detail: 'DM sent.', checkedAt: 'x' } },
      'POST /api/v1/verify/saml': { body: { state: 'pass', detail: 'IdP answered 200.', checkedAt: 'x' } },
      'POST /api/v1/verify/mcp': { body: { state: 'fail', detail: 'The MCP server is switched off.', checkedAt: 'x' } },
      'GET /api/v1/mcp/tokens': { body: { tokens: [{ id: 1, name: 'Claude Desktop — Asha', kind: 'personal', owner: { userName: 'users/1', displayName: 'Asha' }, scopes: ['read'], createdAt: 'x', lastUsedAt: null, expiresAt: 'y', revokedAt: null }, { id: 2, name: 'gone', kind: 'service', owner: null, scopes: ['read'], createdAt: 'x', lastUsedAt: null, expiresAt: 'y', revokedAt: 'z' }] } },
      'POST /api/v1/mcp/tokens': { status: 201, body: (init?: RequestInit) => ({ id: 3, ...parse(init), owner: null, createdAt: 'x', lastUsedAt: null, expiresAt: 'y', revokedAt: null, secret: 'amcp_secret', config: { url: 'http://localhost:3000/mcp', headers: { Authorization: 'Bearer amcp_secret' } } }) },
      'DELETE /api/v1/mcp/tokens/1': { status: 204, body: null },
      'GET /api/v1/mcp/activity?limit=8': { body: { activity: [{ id: 1, token: { id: 1, name: 'Claude Desktop — Asha' }, tool: 'list_standups', argsSummary: '{}', ok: true, at: '2026-09-16T05:22:00Z' }, { id: 2, token: { id: 1, name: 'Claude Desktop — Asha' }, tool: 'resolve_blocker', argsSummary: '{"blockerId":9}', ok: false, at: '2026-09-16T05:21:00Z' }] } },
      'POST /api/v1/settings/tokens/tick': { status: 201, body: { name: 'tick', token: 'tick-secret' } },
      'DELETE /api/v1/settings/tokens/export': { status: 204, body: null },
      ...over,
    }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('blockers workspace', () => {
  it('filters by status, standup, owner and escalation, and acts on rows', async () => {
    const { calls } = server();
    renderApp('/blockers');
    const user = userEvent.setup();
    expect(await screen.findByRole('tab', { name: 'Open · 1' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Acknowledged · 1' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Resolved · 1' })).toBeInTheDocument();
    expect(await screen.findByText('Waiting on API keys')).toBeInTheDocument();
    expect(screen.getByText('Escalated')).toHaveClass('badge-danger');
    expect(screen.getByText('3 days')).toBeInTheDocument();
    expect(screen.getByLabelText('Tagged: Asha')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(calls).toContain('POST /api/v1/blockers/11/acknowledge'));
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the owner');

    await user.click(screen.getByRole('tab', { name: 'Acknowledged · 1' }));
    expect(await screen.findByText('CI saturated')).toBeInTheDocument();
    expect(screen.getByText('Last update: Talking to infra')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update' }));
    await user.type(screen.getByLabelText('Update text'), 'Runners doubled');
    await user.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(calls).toContain('POST /api/v1/blockers/12/update'));

    await user.click(screen.getByRole('tab', { name: 'Resolved · 1' }));
    expect(await screen.findByText('Resolved Thu 10 Sept')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Open · 1' }));
    await user.click(screen.getByRole('button', { name: 'Escalated only' }));
    expect(await screen.findByText('Waiting on API keys')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Owner'), 'users/carol');
    expect(await screen.findByText(/Nothing here/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Owner'), '');
    await user.selectOptions(screen.getByLabelText('Standup'), '1');
    await waitFor(() => expect(calls).toContain('GET /api/v1/blockers?status=open&standupId=1'));
  });

  it('hides actions from the operator token', async () => {
    server({}, OPERATOR);
    renderApp('/blockers');
    expect(await screen.findByText('Waiting on API keys')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });
});

describe('reports', () => {
  it('shows headline numbers, charts and blockers raised this week', async () => {
    server();
    renderApp('/reports');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeInTheDocument();
    expect((await screen.findAllByText('90%'))[0]).toBeInTheDocument();
    expect(screen.getByText('↑ 20 pts vs previous 8 weeks')).toBeInTheDocument();
    expect(screen.getByText('4 / 5')).toBeInTheDocument();
    expect(screen.getByText('8 · 4')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Weekly participation percentage' })).toBeInTheDocument();
    expect(await screen.findByText('Waiting on API keys')).toBeInTheDocument();
    expect(screen.queryByText('Old one')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Standup'), '1');
    expect(await screen.findByRole('link', { name: 'Export CSV' })).toHaveAttribute('href', '/api/v1/standups/1/export.csv?days=56');
    await user.selectOptions(screen.getByLabelText('Period'), '4');
    await waitFor(() => expect(screen.getByText('Last 4 weeks · Engineering')).toBeInTheDocument());
    expect(headline([])).toEqual({ part: null, partDelta: null, mood: null, opened: 0, resolved: 0 });
  });
});

describe('team', () => {
  it('lists people with roles and status, filters, and offers roster actions with confirmation', async () => {
    const { calls } = server();
    renderApp('/team');
    const user = userEvent.setup();
    expect(await screen.findByText('2 people across 1 standup')).toBeInTheDocument();
    expect(screen.getByText('Manager')).toHaveClass('badge-info');
    expect(screen.getByText('Away')).toHaveClass('badge-warning');
    expect(screen.getByText('Engineering (optional)')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Managers · 1' }));
    expect(screen.queryByText('Bob Mehta')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Away · 1' }));
    expect(screen.getByText('Bob Mehta')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Everyone · 2' }));

    await user.click(screen.getByRole('button', { name: 'Actions for Bob Mehta' }));
    await user.click(screen.getByRole('menuitem', { name: 'Make mandatory' }));
    await waitFor(() => expect(calls).toContain('PATCH /api/v1/standups/1/participants/users%2Fbob'));
    await user.click(screen.getByRole('button', { name: 'Actions for Bob Mehta' }));
    await user.click(screen.getByRole('menuitem', { name: 'Mark as back' }));
    await user.click(screen.getByRole('button', { name: 'Actions for Asha Verma' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove as manager' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('without an admin');

    await user.click(screen.getByRole('button', { name: 'Actions for Bob Mehta' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove from Engineering' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remove Bob Mehta from Engineering?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Actions for Bob Mehta' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove from Engineering' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/v1/standups/1/participants/users%2Fbob'));
  });

  it('reports a failed load', async () => {
    server({ 'GET /api/v1/people': { status: 403, body: { error: { code: 'forbidden', message: 'Only admins and managers can list the team.' } } } }, MEMBER);
    renderApp('/team');
    expect(await screen.findByText(/Could not load the team/)).toBeInTheDocument();
  });
});

describe('settings', () => {
  it('navigates sections and saves general defaults', async () => {
    const { patches } = server();
    renderApp('/settings');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    await user.selectOptions(screen.getByLabelText('Default timezone'), 'UTC');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toContainEqual({ defaultTimezone: 'UTC' }));
    await user.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(patches).toContainEqual({ calendarOoo: false }));
  });

  it('manages the Google Chat connection', async () => {
    const { patches } = server();
    renderApp('/settings/chat');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Google Chat' })).toBeInTheDocument();
    expect(screen.getByLabelText('Project number')).toHaveValue('728449131907');
    await user.clear(screen.getByLabelText('Project number'));
    await user.type(screen.getByLabelText('Project number'), '999');
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]!);
    await waitFor(() => expect(patches).toContainEqual({ chatAudience: '999 https://x/chat/events' }));
    expect(await screen.findByText(/Audience looks right/)).toBeInTheDocument();
    expect(screen.getByText('bot@x.iam')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getAllByRole('button', { name: 'Verify' })[1]!);
    expect(await screen.findByText(/Key verified/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check events' }));
    expect(await screen.findByText(/No event received yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send me a test DM' }));
    expect(await screen.findByText(/DM sent/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText('Workspace admin to act as'), 'admin@x.dev');
    await user.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
    await waitFor(() => expect(patches).toContainEqual({ workspaceAdminEmail: 'admin@x.dev' }));
    expect(await screen.findByText(/acting as admin@x.dev/)).toBeInTheDocument();
    expect(screen.getByText('104928')).toBeInTheDocument();
  });

  it('edits sign-in methods and surfaces the lockout refusal', async () => {
    const { patches } = server();
    renderApp('/settings/sign-in');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Sign-in & SSO' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up' }));
    await user.type(screen.getByLabelText('OAuth client ID'), 'x.apps.googleusercontent.com');
    await user.type(screen.getByLabelText('OAuth client secret'), 'GOCSPX-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toContainEqual({ oauthClientId: 'x.apps.googleusercontent.com', oauthClientSecret: 'GOCSPX-1' }));
    expect(await screen.findAllByRole('button', { name: 'Change' })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Check IdP' }));
    expect(await screen.findByText(/IdP answered 200/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox'));
    expect(await screen.findByRole('alert')).toHaveTextContent('lockout');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(patches).toContainEqual({ oauthClientId: '', oauthClientSecret: null }));
  });

  it('runs the MCP server section end to end', async () => {
    const { patches, calls } = server();
    renderApp('/settings/mcp');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'MCP server' })).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    await user.click(screen.getAllByRole('checkbox')[0]!);
    await waitFor(() => expect(patches).toContainEqual({ mcpEnabled: true }));
    expect(await screen.findByText('Enabled')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/switched off/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('checkbox')[2]!);
    await waitFor(() => expect(patches).toContainEqual({ mcpDefaultScopes: 'read,blockers:write' }));
    expect((await screen.findAllByText('Claude Desktop — Asha'))[0]).toBeInTheDocument();
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
    expect(screen.getByText('refused', { exact: false })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New token' }));
    await user.type(screen.getByLabelText('Name'), 'Cursor — Dev');
    await user.click(screen.getByRole('button', { name: 'submit' }));
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByText('amcp_secret')).toBeInTheDocument();
    expect(calls).toContain('POST /api/v1/mcp/tokens');
    await user.click(screen.getByRole('tab', { name: 'Claude Code' }));
    expect(screen.getByText(/claude mcp add --transport http/)).toHaveTextContent('amcp_secret');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/v1/mcp/tokens/1'));
  });

  it('generates and clears machine tokens', async () => {
    const { calls } = server();
    renderApp('/settings/tokens');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'API & tokens' })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Generate' })[0]!);
    expect(await screen.findByText('tick-secret')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/v1/settings/tokens/export'));
  });

  it('disconnects Google Chat only after the typed confirmation', async () => {
    const { patches } = server();
    renderApp('/settings/danger');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Danger zone' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Disconnect' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'DISCONNECT');
    await user.click(confirm);
    await waitFor(() => expect(patches).toContainEqual({ chatAudience: '', serviceAccountJson: null, setupComplete: false }));
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
  });
});
