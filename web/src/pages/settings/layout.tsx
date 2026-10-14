import { Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import { can, type Permission } from '../../lib/access';
import { useMe } from '../../lib/auth';

const NAV: { to: string; label: string; need: Permission; exact?: true }[] = [
  { to: '/settings', label: 'General', need: 'settings.manage', exact: true },
  { to: '/settings/chat', label: 'Google Chat', need: 'settings.manage' },
  { to: '/settings/sign-in', label: 'Sign-in & SSO', need: 'sso.manage' },
  { to: '/settings/mcp', label: 'MCP server', need: 'settings.manage' },
  { to: '/settings/tokens', label: 'API & tokens', need: 'tokens.manage' },
  { to: '/settings/roles', label: 'Roles', need: 'roles.manage' },
  { to: '/settings/access', label: 'Access', need: 'roles.manage' },
  { to: '/settings/danger', label: 'Danger zone', need: 'settings.manage' },
];

/** Only the sections the caller's permissions open; the first one stands in for General. */
export function SettingsLayout() {
  const me = useMe().data;
  // The router reports the path with or without the /app base depending on how it was reached.
  const path = useRouterState({ select: (s) => s.location.pathname }).replace(/^\/app(?=\/|$)/, '');
  const nav = NAV.filter((n) => can(me, n.need));
  const isCurrent = (n: (typeof NAV)[number]) => (n.exact ? path === n.to || path === `${n.to}/` : path.startsWith(n.to));
  const current = NAV.find(isCurrent);
  if (nav.length === 0) return <div className="alert">You don’t have access to any settings. Ask an admin if you need it.</div>;
  if (current && !can(me, current.need)) {
    if (current.exact) return <Navigate to={nav[0]!.to} replace />;
    return <div className="alert">You don’t have access to this part of settings.</div>;
  }
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {nav.map((n) => <Link key={n.to} to={n.to} aria-current={isCurrent(n) ? 'page' : undefined}>{n.label}</Link>)}
      </nav>
      <div className="settings-pane">
        <Outlet />
      </div>
    </div>
  );
}

export function SettingsHeader({ title, lede }: { title: string; lede: string }) {
  return (
    <div>
      <h1 className="t-h2" style={{ margin: 0 }}>{title}</h1>
      <p className="t-small secondary" style={{ margin: '4px 0 0' }}>{lede}</p>
    </div>
  );
}

/** The API's field error shown next to the row that caused it. */
export function fieldError(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: string }).message);
  return 'That did not save.';
}
