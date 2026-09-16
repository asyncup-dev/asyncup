import { Link, Outlet, useRouterState } from '@tanstack/react-router';

const NAV = [
  { to: '/settings', label: 'General', exact: true },
  { to: '/settings/chat', label: 'Google Chat' },
  { to: '/settings/sign-in', label: 'Sign-in & SSO' },
  { to: '/settings/mcp', label: 'MCP server' },
  { to: '/settings/tokens', label: 'API & tokens' },
  { to: '/settings/danger', label: 'Danger zone' },
] as const;

export function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {NAV.map((n) => {
          const current = 'exact' in n ? pathname === `/app${n.to}` || pathname === `/app${n.to}/` : pathname.startsWith(`/app${n.to}`);
          return <Link key={n.to} to={n.to} aria-current={current ? 'page' : undefined}>{n.label}</Link>;
        })}
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
