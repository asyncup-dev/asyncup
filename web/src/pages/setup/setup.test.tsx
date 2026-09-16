import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatHealth, Settings, Template, Verification } from '../../lib/api';
import { ADMIN, MEMBER, renderApp, stubApi } from '../../test/harness';
import { cadence } from './template';

const pass = (detail: string): Verification => ({ state: 'pass', detail, checkedAt: '2026-09-16T10:00:00Z' });
const fail = (detail: string): Verification => ({ state: 'fail', detail, checkedAt: '2026-09-16T10:00:00Z' });

const TEMPLATES: Template[] = [
  { id: 'daily-standup', name: 'Daily standup', description: 'd', questions: ['What did you do yesterday?', 'What will you do today?', 'Any blockers?'], days: ['mon', 'tue', 'wed', 'thu', 'fri'], promptTime: '09:30', deadlineTime: '11:30', moodEnabled: true, moodAnonymous: false, digestEnabled: true },
  { id: 'weekly-retro', name: 'Weekly retro', description: 'r', questions: ['What went well?', 'What did not?'], days: ['fri'], promptTime: '15:00', deadlineTime: '17:00', moodEnabled: true, moodAnonymous: true, digestEnabled: false },
  { id: 'blank', name: 'Blank', description: 'Just the defaults — write your own questions.', questions: null, days: ['mon', 'tue', 'wed', 'thu', 'fri'], promptTime: '09:30', deadlineTime: '11:30', moodEnabled: true, moodAnonymous: false, digestEnabled: false },
];

function freshSettings(): Settings {
  return {
    chat: { audience: '', serviceAccount: { set: false, email: null, clientId: null } },
    workspace: { defaultTimezone: 'Asia/Kolkata', calendarOoo: true, workspaceAdminEmail: '' },
    signIn: { tokenSignIn: true, google: { clientId: '', clientSecret: { set: false }, on: false }, saml: { entityId: '', ssoUrl: '', cert: { set: false }, adminAttribute: '', adminGroup: '', on: false } },
    setup: { complete: false, chatConfigured: false, signInConfigured: false },
  };
}

/** Enough of the API to walk the whole flow: settings are applied, verify answers are scripted. */
function fakeServer(seed: { settings?: (s: Settings) => void; lastEventAt?: string | null; standups?: unknown[]; verify?: Partial<Record<string, Verification>> } = {}) {
  const settings = freshSettings();
  seed.settings?.(settings);
  const state = {
    settings,
    health: { audience: 'unset', serviceAccount: 'unset', lastEventAt: seed.lastEventAt ?? null, lastRejectedAt: null } as ChatHealth,
    standups: seed.standups ?? [],
    verify: { project: pass('Audience looks right.'), 'service-account': pass('Key verified for bot@x — the app is already in at least one space.'), 'chat-event': fail('No event received yet.'), saml: pass('IdP answered 200.'), ...seed.verify },
    patches: [] as Record<string, unknown>[],
    posted: [] as Record<string, unknown>[],
  };
  const apply = (patch: Record<string, unknown>) => {
    state.patches.push(patch);
    const s = state.settings;
    if (typeof patch.chatAudience === 'string') s.chat.audience = patch.chatAudience;
    if (typeof patch.serviceAccountJson === 'string') {
      const k = JSON.parse(patch.serviceAccountJson);
      s.chat.serviceAccount = { set: true, email: k.client_email, clientId: k.client_id ?? null };
    }
    if (typeof patch.workspaceAdminEmail === 'string') s.workspace.workspaceAdminEmail = patch.workspaceAdminEmail;
    if (typeof patch.calendarOoo === 'boolean') s.workspace.calendarOoo = patch.calendarOoo;
    if (typeof patch.oauthClientId === 'string') s.signIn.google = { clientId: patch.oauthClientId, clientSecret: { set: true }, on: true };
    if (typeof patch.samlIdpEntityId === 'string') s.signIn.saml = { ...s.signIn.saml, entityId: patch.samlIdpEntityId, ssoUrl: String(patch.samlIdpSsoUrl), cert: { set: true }, on: true };
    if (patch.setupComplete === true) s.setup.complete = true;
    s.setup.chatConfigured = !!(s.chat.audience && s.chat.serviceAccount.set);
    s.setup.signInConfigured = s.signIn.google.on || s.signIn.saml.on;
    return s;
  };
  const parse = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  const stub = stubApi({
    'GET /api/v1/me': { body: ADMIN },
    'GET /api/v1/settings': { body: () => state.settings },
    'PATCH /api/v1/settings': { body: (init?: RequestInit) => apply(parse(init)) },
    'GET /health/chat': { body: () => state.health },
    'GET /api/v1/standups': { body: () => ({ standups: state.standups }) },
    'POST /api/v1/verify/project': { body: () => state.verify.project },
    'POST /api/v1/verify/service-account': { body: () => state.verify['service-account'] },
    'POST /api/v1/verify/chat-event': {
      body: () => {
        const v = state.verify['chat-event']!;
        if (v.state === 'pass') state.health.lastEventAt = '2026-09-16T10:05:00Z';
        return v;
      },
    },
    'POST /api/v1/verify/saml': { body: () => state.verify.saml },
    'GET /api/v1/templates': { body: { templates: TEMPLATES } },
    'GET /api/v1/spaces': { body: { spaces: [{ name: 'spaces/team', displayName: 'Platform HQ', standups: [] }, { name: 'spaces/busy', displayName: 'Busy', standups: [{ id: 1, name: 'Old' }] }] } },
    'GET /api/v1/spaces/spaces%2Fteam/members': { body: { members: [{ userName: 'users/asha', displayName: 'Asha' }, { userName: 'users/rohit', displayName: 'Rohit' }] } },
    'GET /api/v1/spaces/spaces%2Fbusy/members': { status: 502, body: { error: { code: 'chat_unavailable', message: 'Google Chat did not answer: quota' } } },
    'POST /api/v1/standups': {
      status: 201,
      body: (init?: RequestInit) => {
        const body = parse(init);
        state.posted.push(body);
        state.standups = [FULL_STANDUP];
        return { id: 7, name: body.name, runNow: body.runNow ? 'started' : null };
      },
    },
    'GET /api/v1/standups/7': { body: { id: 7, name: 'Engineering daily', spaceName: 'spaces/team', schedule: { promptTime: '09:30', deadlineTime: '11:30', timezone: 'Asia/Kolkata', days: ['mon'], reminderMinutesBefore: 60 }, people: { total: 3, mandatory: 2 } } },
    'GET /api/v1/standups/7/runs/today': {
      body: () => ({
        date: '2026-09-16',
        status: state.standups.length ? 'open' : null,
        expected: 3,
        submitted: [{ userName: 'users/asha', displayName: 'Asha', submittedAt: '2026-09-16T05:14:00Z', late: false, mood: 'good' }],
        waiting: [{ userName: 'users/rohit', displayName: 'Rohit', mandatory: true, remindedAt: null }, { userName: 'users/carol', displayName: 'Carol', mandatory: false, remindedAt: '2026-09-16T05:30:00Z' }],
        away: [{ userName: 'users/dev', displayName: 'Dev', reason: 'vacation' }],
        teamMood: null,
      }),
    },
    'GET /api/v1/standups/9': { status: 404, body: { error: { code: 'not_found', message: 'No such standup.' } } },
    'GET /api/v1/standups/9/runs/today': { status: 404, body: { error: { code: 'not_found', message: 'No such standup.' } } },
  });
  return { state, ...stub };
}

const FULL_STANDUP = {
  id: 7,
  name: 'Engineering daily',
  spaceName: 'spaces/team',
  active: true,
  schedule: { promptTime: '09:30', deadlineTime: '11:30', timezone: 'Asia/Kolkata', days: ['mon'], reminderMinutesBefore: 60 },
  people: { total: 3, mandatory: 2 },
  today: { date: '2026-09-16', status: 'open', submitted: 1, expected: 3, missing: [] },
  permissions: { manage: true },
};
const SA_KEY = JSON.stringify({ type: 'service_account', client_email: 'bot@p.iam.gserviceaccount.com', client_id: '104928374655120039382', private_key: 'k' });

afterEach(() => vi.unstubAllGlobals());

describe('setup: entry and guard', () => {
  it('sends admins with unfinished setup to the walkthrough, and finished ones to the list', async () => {
    fakeServer();
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Let’s get your first standup running' })).toBeInTheDocument();
    expect(screen.getAllByText('To do')).toHaveLength(4);
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start' })).toHaveAttribute('href', '/app/setup/project');

    cleanup();
    fakeServer({ settings: (s) => { s.setup.complete = true; }, standups: [FULL_STANDUP] });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Standups' })).toBeInTheDocument();
  });

  it('skips to the standup step when Chat already works, and keeps members out', async () => {
    fakeServer({ settings: (s) => { s.chat.audience = '728449131907'; s.chat.serviceAccount = { set: true, email: 'b@x', clientId: '1' }; }, lastEventAt: '2026-09-16T09:00:00Z' });
    renderApp('/setup');
    expect(await screen.findByRole('link', { name: 'Continue' })).toHaveAttribute('href', '/app/setup/template');
    expect(screen.getByText(/Continue skips straight to step 5/)).toBeInTheDocument();
    expect(screen.getAllByText('Done')).toHaveLength(3);

    cleanup();
    stubApi({ 'GET /api/v1/me': { body: MEMBER }, 'GET /api/v1/me/standups': { body: { linked: false, standups: [] } }, 'GET /api/v1/me/submissions?limit=5': { body: { submissions: [] } } });
    renderApp('/setup');
    expect(await screen.findByText('Your account is not linked to Google Chat yet')).toBeInTheDocument();

    cleanup();
    stubApi({ 'GET /api/v1/me': { status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } }, 'GET /api/v1/auth/methods': { body: { google: false, saml: false, token: true } } });
    renderApp('/setup/project');
    expect(await screen.findByRole('heading', { name: 'Sign in to AsyncUp' })).toBeInTheDocument();
  });

  it('offers setup from the empty standups list', async () => {
    fakeServer({ settings: (s) => { s.setup.complete = true; } });
    renderApp('/standups');
    expect(await screen.findByRole('link', { name: 'Set up your first standup' })).toHaveAttribute('href', '/app/setup');
  });
});

describe('setup: Google Cloud steps', () => {
  it('saves and verifies the project number, keeping an app-URL audience', async () => {
    const { state } = fakeServer({ settings: (s) => { s.chat.audience = 'https://asyncup.example/chat/events'; } });
    renderApp('/setup/project');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Create a Google Cloud project' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
    const box = screen.getAllByRole('checkbox')[0]!;
    await user.click(box);
    expect(box).toBeChecked();
    const verify = screen.getByRole('button', { name: 'Verify' });
    expect(verify).toBeDisabled();
    await user.type(screen.getByLabelText('Project number'), '728449131907');
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(verify);
    expect(await screen.findByText(/Audience looks right/)).toBeInTheDocument();
    expect(state.patches[0]).toEqual({ chatAudience: '728449131907 https://asyncup.example/chat/events' });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'false'));
  });

  it('validates, stores and verifies the service-account key and the delegation settings', async () => {
    const { state } = fakeServer();
    renderApp('/setup/service-account');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Service account' })).toBeInTheDocument();
    const paste = screen.getByLabelText('Service-account key (JSON)');
    await user.type(paste, '{{"type":"x"}');
    await user.click(screen.getByRole('button', { name: 'Save and verify key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('missing client_email');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.type(paste, 'not json');
    await user.click(screen.getByRole('button', { name: 'Save and verify key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('valid JSON');

    await user.clear(paste);
    await user.paste(SA_KEY);
    await user.click(screen.getByRole('button', { name: 'Save and verify key' }));
    expect(await screen.findByText(/Key verified for bot@x/)).toBeInTheDocument();
    expect(state.patches[0]).toEqual({ serviceAccountJson: SA_KEY });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify stored key' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Verify stored key' }));

    await user.click(screen.getByLabelText(/Directory & Calendar access/));
    expect(await screen.findByText('104928374655120039382')).toBeInTheDocument();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
    await user.click(screen.getAllByRole('button', { name: 'Copy' })[0]!);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save access settings' });
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('Workspace admin to act as'), 'admin@example.com');
    await user.click(save);
    await waitFor(() => expect(state.patches.at(-1)).toEqual({ workspaceAdminEmail: 'admin@example.com', calendarOoo: true }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'false'));
  });

  it('shows the exact Chat app values, saves the audience and listens for the first event', async () => {
    const { state } = fakeServer({ settings: (s) => { s.chat.audience = '728449131907'; s.chat.serviceAccount = { set: true, email: 'b@x', clientId: '1' }; } });
    renderApp('/setup/chat-app');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Configure the Chat app' })).toBeInTheDocument();
    expect(screen.getByText(`${location.origin}/chat/events`)).toBeInTheDocument();
    expect(screen.getByText(`${location.origin}/app/logo-256.png`)).toBeInTheDocument();
    expect(screen.getByText('Up to 40 alphanumeric characters')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save audience' }));
    await waitFor(() => expect(state.patches[0]).toEqual({ chatAudience: `728449131907 ${location.origin}/chat/events` }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save audience' })).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Start listening' }));
    expect(await screen.findByText(/No event received yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Stop listening' }));

    state.verify['chat-event'] = pass('A signed event arrived.');
    await user.click(screen.getByRole('button', { name: 'Start listening' }));
    expect(await screen.findByText(/A signed event from Google Chat arrived at 2026-09-16T10:05:00Z/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('aria-disabled', 'false'));
    expect(screen.queryByText(/Continue unlocks/)).not.toBeInTheDocument();
  });
});

describe('setup: sign-in, template, create and live', () => {
  it('configures Google and SAML sign-in inline', async () => {
    const { state } = fakeServer();
    renderApp('/setup/sign-in');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'How will your team sign in?' })).toBeInTheDocument();
    expect(screen.getByText('Step 4 of 5 · optional')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up Google sign-in' }));
    await user.type(screen.getByLabelText('OAuth client ID'), 'x.apps.googleusercontent.com');
    await user.type(screen.getByLabelText('OAuth client secret'), 'GOCSPX-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.patches[0]).toEqual({ oauthClientId: 'x.apps.googleusercontent.com', oauthClientSecret: 'GOCSPX-1' }));
    expect(await screen.findByText('Configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change Google sign-in' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Set up SAML' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Set up SAML' }));
    await user.type(screen.getByLabelText('IdP entity ID'), 'https://idp');
    await user.type(screen.getByLabelText('IdP SSO URL'), 'https://idp/sso');
    await user.type(screen.getByLabelText('IdP certificate (PEM)'), 'MIIC');
    await user.click(screen.getByRole('button', { name: 'Save and check' }));
    expect(await screen.findByText(/IdP answered 200/)).toBeInTheDocument();
    expect(state.patches[1]).toEqual({ samlIdpEntityId: 'https://idp', samlIdpSsoUrl: 'https://idp/sso', samlIdpCert: 'MIIC' });
    expect(screen.getByRole('link', { name: 'Skip for now' })).toHaveAttribute('href', '/app/setup/template');
  });

  it('lists templates and carries the choice into the create form', async () => {
    fakeServer();
    renderApp('/setup/template');
    const user = userEvent.setup();
    expect(await screen.findByRole('radio', { name: /Daily standup/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Most popular')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Weekly retro/ }));
    expect(screen.getByRole('link', { name: 'Continue with Weekly retro' })).toHaveAttribute('href', '/app/setup/create?template=weekly-retro');
    expect(cadence(TEMPLATES[0]!)).toBe('Every weekday · 3 questions');
    expect(cadence(TEMPLATES[1]!)).toBe('Fri · 2 questions · anonymous mood');
    expect(cadence(TEMPLATES[2]!)).toBe('Every weekday · you decide');
    expect(cadence({ ...TEMPLATES[1]!, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], questions: ['One?'], moodAnonymous: false })).toBe('Every day · 1 question');
  });

  it('builds the first standup from the template, the space and its members, then shows the live run', async () => {
    const { state } = fakeServer();
    renderApp('/setup/create?template=daily-standup');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Create your first standup' })).toBeInTheDocument();
    expect(screen.getByText('Template: Daily standup')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Daily standup');
    expect(screen.getByLabelText('Question 3')).toHaveValue('Any blockers?');
    expect(screen.getByText('Nobody yet — pick a space to see who is in it.')).toBeInTheDocument();
    const run = screen.getByRole('button', { name: 'Create and run it now' });
    expect(run).toBeDisabled();

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Engineering daily');
    await user.selectOptions(screen.getByLabelText('Post in space'), 'spaces/team');
    expect(await screen.findByRole('button', { name: '+ Asha' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ Asha' }));
    await user.click(screen.getByRole('button', { name: 'Add all' }));
    expect(screen.getByText('Everyone in the space is on the list.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make optional: Rohit' }));
    expect(within(screen.getByLabelText('Participants')).getByText('optional')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make mandatory: Rohit' }));
    await user.click(screen.getByRole('button', { name: 'Remove Asha' }));

    await user.click(screen.getByRole('button', { name: 'Sat' }));
    await user.click(screen.getByRole('button', { name: 'Mon' }));
    await user.selectOptions(screen.getByLabelText('Timezone'), 'UTC');
    await user.click(screen.getByRole('button', { name: '+ Add question' }));
    await user.type(screen.getByLabelText('Question 4'), 'Anything to celebrate?');
    await user.click(screen.getByRole('button', { name: 'Move question 4 up' }));
    await user.click(screen.getByRole('button', { name: 'Remove question 1' }));
    await user.click(screen.getByLabelText('Keep individual moods anonymous'));

    await user.click(screen.getByRole('button', { name: 'Create and run it now' }));
    expect(await screen.findByRole('heading', { name: 'Engineering daily is live' })).toBeInTheDocument();
    const body = state.posted[0]!;
    expect(body).toMatchObject({ templateId: 'daily-standup', name: 'Engineering daily', spaceName: 'spaces/team', timezone: 'UTC', runNow: true, moodEnabled: true, moodAnonymous: true });
    expect(body.days).toEqual(['tue', 'wed', 'thu', 'fri', 'sat']);
    expect(body.questions).toEqual(['What will you do today?', 'Anything to celebrate?', 'Any blockers?']);
    expect(body.participants).toEqual([{ userName: 'users/rohit', displayName: 'Rohit', mandatory: true }]);
    expect(state.patches.at(-1)).toEqual({ setupComplete: true });

    expect(screen.getByText('1 of 3 submitted')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Reminded')).toBeInTheDocument();
    expect(screen.getByText('On vacation')).toBeInTheDocument();
    expect(screen.getByText(/11:30 — the run closes/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the console' })).toHaveAttribute('href', '/app/standups');
  });

  it('reports member lookup failures and create errors, and handles the blank template', async () => {
    const { state } = fakeServer();
    renderApp('/setup/create');
    const user = userEvent.setup();
    expect(await screen.findByText('Template: Blank')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    await user.selectOptions(screen.getByLabelText('Post in space'), 'spaces/busy');
    expect(await screen.findByText(/Could not list members: Google Chat did not answer: quota/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'Old');
    state.posted.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/v1/standups' && init?.method === 'POST') return { ok: false, status: 409, json: async () => ({ error: { code: 'duplicate', message: 'This space already has a standup named "Old" (#1).' } }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    await user.click(screen.getByRole('button', { name: 'Create without running' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already has a standup named');
  });

  it('shows a run that has not started, and a missing standup', async () => {
    fakeServer({ standups: [] });
    renderApp('/setup/live?standup=7');
    expect(await screen.findByRole('heading', { name: 'Engineering daily is ready' })).toBeInTheDocument();
    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.getByText(/first prompt goes out at 09:30 Asia\/Kolkata/)).toBeInTheDocument();

    cleanup();
    fakeServer();
    renderApp('/setup/live?standup=9');
    expect(await screen.findByText(/Could not load the standup: No such standup/)).toBeInTheDocument();
  });
});
