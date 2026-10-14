import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '../../../../src/core/permission-catalogue.ts';
import { can, canSomewhere, heldAt, mayResolve, type Permission } from '../../lib/access';
import type { BlockerView, Me } from '../../lib/api';
import { grantableAt, grantee, type Grant, type Role } from '../../lib/roles';
import { ADMIN, renderApp, stubApi } from '../../test/harness';
import { holders } from './roles';

const ALL = Object.keys(PERMISSIONS) as Permission[];
const CATALOGUE = ALL.map((id) => ({ id, ...PERMISSIONS[id] }));
const MANAGER_PERMS: Permission[] = ['standups.view', 'standups.configure', 'standups.archive', 'people.view', 'people.manage', 'schedules.manage', 'answers.view', 'blockers.view', 'blockers.manage', 'reports.view', 'export'];
const VIEWER_PERMS: Permission[] = ['standups.view', 'people.view', 'answers.view', 'blockers.view', 'reports.view', 'export'];
const ROLES: Role[] = [
  { id: 'admin', name: 'Admin', description: 'Everything.', permissions: ALL, builtIn: true, grantable: true, workspaceOnly: true, grants: 2 },
  { id: 'manager', name: 'Manager', description: 'Runs standups.', permissions: MANAGER_PERMS, builtIn: true, grantable: true, workspaceOnly: false, grants: 0 },
  { id: 'viewer', name: 'Viewer', description: 'Reads everything.', permissions: VIEWER_PERMS, builtIn: true, grantable: true, workspaceOnly: false, grants: 3 },
  { id: 'member', name: 'Member', description: 'Answers.', permissions: ['standups.view', 'answers.view', 'blockers.view', 'reports.view'], builtIn: true, grantable: false, workspaceOnly: false, grants: 0 },
  { id: '7', name: 'Auditor', description: '', permissions: ['standups.view', 'answers.view'], builtIn: false, grantable: true, workspaceOnly: false, grants: 1 },
];
const GRANTS: Grant[] = [
  { id: 1, email: 'lee@example.com', displayName: 'Lee Park', role: { id: 'viewer', name: 'Viewer' }, standup: null, grantedBy: 'Asha Rao', grantedAt: '2026-10-01T10:00:00Z' },
  { id: 2, email: 'kim@example.com', displayName: 'kim@example.com', role: { id: '7', name: 'Auditor' }, standup: { id: 1, name: 'Engineering' }, grantedBy: 'Asha Rao', grantedAt: '2026-10-02T10:00:00Z' },
];
const STANDUP = { id: 1, name: 'Engineering', spaceName: 'spaces/A', active: true, schedule: { promptTime: '09:30', deadlineTime: '11:30', timezone: 'Asia/Kolkata', days: ['mon'], reminderMinutesBefore: 60 }, people: { total: 2, mandatory: 2 }, today: { date: '2026-09-16', status: null, submitted: 0, expected: 0, missing: [] }, permissions: { manage: true } };
/** Manages roles and reads standups, but none of the other settings. */
const ROLE_ADMIN: Me = { kind: 'manager', via: 'session', tenantId: 'default', user: { userName: 'users/r', email: 'r@example.com', name: 'Rae' }, managedStandupIds: [], permissions: { workspace: ['standups.view', 'people.view', 'answers.view', 'roles.manage'], standups: {} } };

function server(me: Me = ADMIN, over: Record<string, { status?: number; body: unknown }> = {}) {
  const bodies: Record<string, unknown>[] = [];
  const record = (answer: unknown) => (init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return answer;
  };
  return {
    bodies,
    ...stubApi({
      'GET /api/v1/me': { body: me },
      'GET /api/v1/permissions': { body: { permissions: CATALOGUE } },
      'GET /api/v1/roles': { body: { roles: ROLES } },
      'POST /api/v1/roles': { status: 201, body: record(ROLES[4]) },
      'PATCH /api/v1/roles/7': { status: 409, body: { error: { code: 'duplicate', message: 'A role called “Viewer” already exists.', field: 'name' } } },
      'DELETE /api/v1/roles/7': { status: 409, body: { error: { code: 'in_use', message: '1 person holds this role. Revoke it first.' } } },
      'GET /api/v1/grants': { body: { grants: GRANTS } },
      'POST /api/v1/grants': { status: 201, body: record({ ...GRANTS[0], id: 3, email: 'new@example.com', displayName: 'new@example.com', role: { id: 'admin', name: 'Admin' } }) },
      'DELETE /api/v1/grants/1': { status: 204, body: null },
      'DELETE /api/v1/grants/2': { status: 409, body: { error: { code: 'lockout', message: 'That would take away your own permission to manage roles.' } } },
      'GET /api/v1/roles/audit?limit=20': { body: { entries: [{ id: 4, at: '2026-10-02T10:00:00Z', actor: 'Asha Rao', action: 'grant.create', summary: 'Granted Auditor to kim@example.com on Engineering.' }] } },
      'GET /api/v1/standups': { body: { standups: [STANDUP] } },
      ...over,
    }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('settings › roles', () => {
  it('lists roles with who holds them, and builds, edits and deletes custom ones', async () => {
    const { calls, bodies } = server();
    renderApp('/settings/roles');
    const user = userEvent.setup();
    const table = within(await screen.findByRole('table', { name: 'Roles' }));
    expect(table.getByText('Everything')).toBeInTheDocument();
    expect(table.getByText('2 of 17')).toBeInTheDocument();
    expect(table.getByText('Everyone on a standup')).toBeInTheDocument();
    expect(table.getByText('Each standup’s managers · 0 grants')).toBeInTheDocument();
    expect(table.getByRole('link', { name: '1 grant' })).toBeInTheDocument();
    expect(table.queryByRole('button', { name: 'Edit Viewer' })).not.toBeInTheDocument();

    await user.click(table.getByRole('button', { name: 'Copy Viewer' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Viewer (copy)');
    await user.click(screen.getByRole('checkbox', { name: /^Export/ }));
    await user.click(screen.getByRole('checkbox', { name: /^Resolve blockers/ }));
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(bodies[0]).toEqual({ name: 'Viewer (copy)', description: 'Reads everything.', permissions: ['standups.view', 'people.view', 'answers.view', 'blockers.view', 'blockers.manage', 'reports.view'] }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Create role' })).not.toBeInTheDocument());

    await user.click(table.getByRole('button', { name: 'Edit Auditor' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Viewer');
    await user.type(screen.getByLabelText('Description'), 'Reads answers');
    await user.click(screen.getByRole('button', { name: 'Save role' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(calls).toContain('PATCH /api/v1/roles/7');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(table.getByRole('button', { name: 'Delete Auditor' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Revoke it first');
  });

  it('only lets people give permissions they hold, and shows only their sections', async () => {
    server(ROLE_ADMIN);
    const user = userEvent.setup();
    renderApp('/settings');
    expect(await screen.findByRole('heading', { name: 'Roles', level: 1 })).toBeInTheDocument();
    const sections = within(screen.getByRole('navigation', { name: 'Settings sections' }));
    expect(sections.getAllByRole('link').map((a) => a.textContent)).toEqual(['Roles', 'Access']);

    await user.click(await screen.findByRole('button', { name: 'New role' }));
    expect(screen.getByRole('checkbox', { name: /^Export/ })).toBeDisabled();
    expect(screen.getAllByText(/You don’t hold this, so you can’t give it/).length).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: 'Create role' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /^Read answers/ }));
    expect(screen.getByRole('checkbox', { name: /^See standups/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^See standups/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // A copy of Admin can still shed what the editor lacks.
    await user.click(screen.getByRole('button', { name: 'Copy Admin' }));
    expect(screen.getByRole('checkbox', { name: /^Manage settings/ })).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: /^Manage settings/ }));
    expect(screen.getByRole('checkbox', { name: /^Manage settings/ })).toBeDisabled();
    cleanup();

    renderApp('/settings/chat');
    expect(await screen.findByText('You don’t have access to this part of settings.')).toBeInTheDocument();
  });

  it('reports a failed load', async () => {
    server(ADMIN, { 'GET /api/v1/roles': { status: 500, body: { error: { code: 'x', message: 'Boom.' } } } });
    renderApp('/settings/roles');
    expect(await screen.findByText('Could not load roles: Boom.')).toBeInTheDocument();
    cleanup();
    server(ADMIN, { 'GET /api/v1/permissions': { status: 500, body: { error: { code: 'x', message: 'Bang.' } } } });
    renderApp('/settings/roles');
    expect(await screen.findByText('Could not load permissions: Bang.')).toBeInTheDocument();
  });
});

describe('settings › access', () => {
  it('lists, filters, grants and revokes, with the history', async () => {
    const { calls, bodies } = server();
    renderApp('/settings/access');
    const user = userEvent.setup();
    const granted = within(await screen.findByRole('table', { name: 'Granted roles' }));
    expect(granted.getByText('Lee Park')).toBeInTheDocument();
    expect(granted.getByText('lee@example.com')).toBeInTheDocument();
    expect(granted.getAllByText('kim@example.com')).toHaveLength(1);
    expect(granted.getByText('Whole workspace')).toBeInTheDocument();
    expect(screen.getByText('Granted Auditor to kim@example.com on Engineering.')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Filter by role'), '7');
    await waitFor(() => expect(screen.queryByText('Lee Park')).not.toBeInTheDocument());
    expect(screen.getByText('Granted · 1')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Filter by role'), '');
    expect(await screen.findByText('Lee Park')).toBeInTheDocument();

    const form = within(screen.getByRole('form', { name: 'Grant a role' }));
    await user.type(form.getByLabelText('Email'), 'new@example.com');
    await user.selectOptions(form.getByLabelText('Role'), 'admin');
    await user.click(form.getByRole('button', { name: 'Grant' }));
    expect(await screen.findByText(/Admin granted to new@example.com across the workspace/)).toBeInTheDocument();
    expect(bodies[0]).toEqual({ email: 'new@example.com', role: 'admin', standupId: null });

    await user.selectOptions(form.getByLabelText('Where'), '1');
    const offered = form.getAllByRole('option').map((o) => o.textContent);
    expect(offered).not.toContain('Admin');
    expect(offered).toContain('Auditor');
    expect(form.getByText(/can only be granted across the workspace/)).toBeInTheDocument();

    await user.click(granted.getAllByRole('button', { name: 'Revoke' })[0]!);
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Revoke Viewer from Lee Park?')).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/v1/grants/1'));
    await user.click(granted.getAllByRole('button', { name: 'Revoke' })[1]!);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('take away your own permission');
  });

  it('shows a filtered view from a role’s link, and a refused grant', async () => {
    server(ADMIN, { 'POST /api/v1/grants': { status: 409, body: { error: { code: 'duplicate', message: 'lee@example.com already has that role there.' } } }, 'GET /api/v1/roles/audit?limit=20': { body: { entries: [] } } });
    renderApp('/settings/roles');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: '1 grant' }));
    expect(await screen.findByText('Granted · 1')).toBeInTheDocument();
    expect(screen.getByText('No changes yet.')).toBeInTheDocument();
    const form = within(screen.getByRole('form', { name: 'Grant a role' }));
    await user.type(form.getByLabelText('Email'), 'lee@example.com');
    await user.type(form.getByLabelText('Name (optional)'), 'Lee');
    await user.click(form.getByRole('button', { name: 'Grant' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already has that role');
  });

  it('reports a failed load and an empty filter', async () => {
    server(ADMIN, { 'GET /api/v1/grants': { status: 500, body: { error: { code: 'x', message: 'Down.' } } } });
    renderApp('/settings/access');
    expect(await screen.findByText('Could not load who holds what: Down.')).toBeInTheDocument();
    cleanup();
    server(ADMIN, { 'GET /api/v1/roles': { status: 500, body: { error: { code: 'x', message: 'Down.' } } } });
    renderApp('/settings/access');
    expect(await screen.findByText('Could not load roles: Down.')).toBeInTheDocument();
    cleanup();
    server(ADMIN, { 'GET /api/v1/grants': { body: { grants: [] } }, 'GET /api/v1/roles/audit?limit=20': { status: 500, body: { error: { code: 'x', message: 'Gone.' } } } });
    renderApp('/settings/access?role=viewer');
    expect(await screen.findByText('Nobody holds this role through a grant.')).toBeInTheDocument();
    expect(await screen.findByText('Could not load the history: Gone.')).toBeInTheDocument();
  });
});

describe('access helpers', () => {
  const me: Me = { ...ADMIN, permissions: { workspace: ['export'], standups: { '1': ['people.manage'] } } };
  const blocker = { owner: { userName: 'users/o', displayName: 'O' }, tags: [{ userName: 'users/t', displayName: 'T', acknowledgedAt: null }], standup: { id: 1, name: 'Eng' } } as BlockerView;

  it('answers like the server', () => {
    expect([can(me, 'export'), can(me, 'people.manage', 1), can(me, 'people.manage', 2), can(me, 'people.manage'), can(null, 'export')]).toEqual([true, true, false, false, false]);
    expect([canSomewhere(me, 'people.manage'), canSomewhere(me, 'roles.manage'), canSomewhere(undefined, 'export')]).toEqual([true, false, false]);
    expect([...heldAt(me, 1)]).toEqual(['export', 'people.manage']);
    expect([...heldAt(me, null)]).toEqual(['export']);
    expect(heldAt(null, 1).size).toBe(0);
    const as = (userName: string | null, permissions: Me['permissions'] = { workspace: [], standups: {} }): Me => ({ ...me, user: userName ? { userName, email: 'x@y', name: 'X' } : null, permissions });
    expect([mayResolve(as('users/o'), blocker), mayResolve(as('users/t'), blocker), mayResolve(as('users/z'), blocker), mayResolve(as(null), blocker)]).toEqual([true, true, false, false]);
    expect(mayResolve(as('users/z', { workspace: [], standups: { '1': ['blockers.manage'] } }), blocker)).toBe(true);
  });

  it('offers only roles that can be granted at a scope', () => {
    expect(grantableAt(ROLES, new Set(ALL), null).map((r) => r.id)).toEqual(['admin', 'manager', 'viewer', '7']);
    expect(grantableAt(ROLES, new Set(ALL), 1).map((r) => r.id)).toEqual(['manager', 'viewer', '7']);
    expect(grantableAt(ROLES, new Set<Permission>(['standups.view', 'answers.view']), 1).map((r) => r.id)).toEqual(['7']);
    expect([grantee(GRANTS[0]!), grantee(GRANTS[1]!)]).toEqual(['Lee Park', 'kim@example.com']);
    expect(holders({ ...ROLES[2]!, grants: 1 })).toBe('1 grant');
  });
});
