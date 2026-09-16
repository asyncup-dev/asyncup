import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, MEMBER, OPERATOR, renderApp, stubApi } from './test/harness';

const SIGNED_OUT = { 'GET /api/v1/me': { status: 401, body: { error: { code: 'unauthenticated', message: 'Sign in, or send a bearer token.' } } } };
const STANDUP = {
  id: 1,
  name: 'Engineering',
  spaceName: 'spaces/AAAA',
  active: true,
  schedule: { promptTime: '09:30', deadlineTime: '11:30', timezone: 'Asia/Kolkata', days: ['mon', 'tue'], reminderMinutesBefore: 60 },
  people: { total: 9, mandatory: 8 },
  today: { date: '2026-09-16', status: 'open', submitted: 7, expected: 9, missing: [{ userName: 'users/5', displayName: 'Asha' }] },
  permissions: { manage: true },
};

afterEach(() => vi.unstubAllGlobals());

describe('sign-in', () => {
  it('shows the enabled methods and signs in with an operator token', async () => {
    const { calls } = stubApi({
      ...SIGNED_OUT,
      'GET /api/v1/auth/methods': { body: { google: true, saml: false, token: true } },
      'GET /api/v1/standups': { body: { standups: [] } },
    });
    renderApp('/sign-in');
    expect(await screen.findByRole('heading', { name: 'Sign in to AsyncUp' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Continue with Google' })).toHaveAttribute('href', '/auth/google');
    expect(screen.queryByText('Continue with SSO')).not.toBeInTheDocument();
    expect(screen.getByText('or')).toBeInTheDocument();

    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Operator token'), 'wrong');
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('That token was not accepted.');
    expect(sessionStorage.getItem('asyncup.token')).toBeNull();

    // The stub answers /me by path, so swap it to accept the retry.
    stubApi({ 'GET /api/v1/me': { body: OPERATOR }, 'GET /api/v1/standups': { body: { standups: [] } } });
    await user.clear(screen.getByLabelText('Operator token'));
    await user.type(screen.getByLabelText('Operator token'), 'right');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Standups' })).toBeInTheDocument();
    expect(sessionStorage.getItem('asyncup.token')).toBe('right');
    expect(calls).toContain('GET /api/v1/auth/methods');
  });

  it('explains when nothing is enabled, or when the server is down', async () => {
    stubApi({ ...SIGNED_OUT, 'GET /api/v1/auth/methods': { body: { google: false, saml: true, token: false } } });
    renderApp('/sign-in');
    expect(await screen.findByRole('link', { name: 'Continue with SSO' })).toHaveAttribute('href', '/auth/saml');
    expect(screen.queryByText('or')).not.toBeInTheDocument();

    cleanup();
    stubApi({ ...SIGNED_OUT, 'GET /api/v1/auth/methods': { body: { google: false, saml: false, token: false } } });
    renderApp('/sign-in');
    expect(await screen.findByText(/No sign-in method is enabled/)).toBeInTheDocument();

    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    renderApp('/sign-in');
    expect(await screen.findByText(/Could not load sign-in options/)).toBeInTheDocument();
  });

  it('sends a signed-in person past the sign-in page', async () => {
    stubApi({ 'GET /api/v1/me': { body: MEMBER } });
    renderApp('/sign-in');
    expect(await screen.findByRole('heading', { name: 'My standups' })).toBeInTheDocument();
  });

  it('reports a token the server no longer accepts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (input.endsWith('/auth/methods')
      ? { ok: true, status: 200, json: async () => ({ google: false, saml: false, token: true }) }
      : (() => { throw new Error('down'); })())));
    renderApp('/sign-in');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Operator token'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server.');
  });
});

describe('shell', () => {
  it('guards the console, lists standups and offers the theme toggle and sign-out', async () => {
    const { calls } = stubApi({ 'GET /api/v1/me': { body: ADMIN }, 'GET /api/v1/standups': { body: { standups: [STANDUP] } } });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Standups' })).toBeInTheDocument();
    expect(screen.getByText('Wed 16 Sept · 1 standup · 1 open today')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('7 / 9 in')).toHaveClass('badge-warning');
    expect(screen.getByRole('link', { name: 'Standups' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getAllByText('AR').length).toBeGreaterThan(0);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Blockers' }));
    expect(await screen.findByRole('heading', { name: 'Blockers' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to AsyncUp' })).toBeInTheDocument();
    expect(calls).toContain('POST /auth/logout');
  });

  it('shows the empty state, the operator identity and member navigation', async () => {
    stubApi({ 'GET /api/v1/me': { body: OPERATOR }, 'GET /api/v1/standups': { body: { standups: [] } } });
    renderApp('/standups');
    expect(await screen.findByText('No standups yet')).toBeInTheDocument();
    expect(screen.getByText('Operator token')).toBeInTheDocument();
    expect(screen.getByText('Nothing running yet')).toBeInTheDocument();

    cleanup();
    stubApi({ 'GET /api/v1/me': { body: MEMBER } });
    renderApp('/me');
    expect(await screen.findByRole('heading', { name: 'My standups' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My standups' })).toHaveAttribute('aria-current', 'page');
  });

  it('redirects a signed-out visitor to sign-in and reports API failures', async () => {
    stubApi({ ...SIGNED_OUT, 'GET /api/v1/auth/methods': { body: { google: false, saml: false, token: true } } });
    renderApp('/standups');
    expect(await screen.findByRole('heading', { name: 'Sign in to AsyncUp' })).toBeInTheDocument();

    cleanup();
    stubApi({ 'GET /api/v1/me': { body: ADMIN }, 'GET /api/v1/standups': { status: 500, body: { error: { code: 'boom', message: 'Database away.' } } } });
    renderApp('/standups');
    expect(await screen.findByText(/Could not load standups: Database away./)).toBeInTheDocument();

    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    renderApp('/standups');
    expect(await screen.findByText(/Could not reach the server: offline/)).toBeInTheDocument();
  });

  it('labels a closed run and a run that has not started', async () => {
    stubApi({
      'GET /api/v1/me': { body: ADMIN },
      'GET /api/v1/standups': { body: { standups: [
        { ...STANDUP, id: 2, name: 'Design', today: { ...STANDUP.today, status: 'closed' } },
        { ...STANDUP, id: 3, name: 'Weekly', today: { ...STANDUP.today, status: null } },
        { ...STANDUP, id: 4, name: 'Done', today: { ...STANDUP.today, missing: [] } },
      ] } },
    });
    renderApp('/standups');
    expect(await screen.findByText('Wrapped up')).toHaveClass('badge-success');
    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.getByText('Wed 16 Sept · 3 standups · 1 open today')).toBeInTheDocument();
    expect(screen.getByText('7 / 9 in')).toHaveClass('badge-success');
  });
});
