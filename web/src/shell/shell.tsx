import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Icons } from '../components/icons';
import { LogoLockup, LogoMark } from '../components/logo';
import { can, canSomewhere, SETTINGS_PERMISSIONS } from '../lib/access';
import { initials, useSignOut } from '../lib/auth';
import type { Me } from '../lib/api';
import { ThemeToggle } from './theme-toggle';

type NavEntry = { to: string; label: string; icon: (p: object) => ReactNode };

/** Members only ever see their own standups; everyone else gets the console pages their permissions open. */
export function navFor(me: Me): NavEntry[] {
  if (me.kind === 'member') return [{ to: '/me', label: 'My standups', icon: Icons.standups }];
  const items: NavEntry[] = [{ to: '/standups', label: 'Standups', icon: Icons.standups }];
  if (canSomewhere(me, 'blockers.view')) items.push({ to: '/blockers', label: 'Blockers', icon: Icons.blockers });
  if (canSomewhere(me, 'reports.view')) items.push({ to: '/reports', label: 'Reports', icon: Icons.reports });
  if (canSomewhere(me, 'people.view')) items.push({ to: '/team', label: 'Team', icon: Icons.team });
  if (SETTINGS_PERMISSIONS.some((p) => can(me, p))) items.push({ to: '/settings', label: 'Settings', icon: Icons.settings });
  return items;
}

export function Shell({ me }: { me: Me }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const nav = navFor(me);
  const current = nav.find((n) => pathname === n.to || pathname.startsWith(`${n.to}/`));
  const signOut = useSignOut();
  const name = me.user?.name ?? 'Operator';
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <LogoLockup />
        </div>
        <nav className="nav">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className="nav-item" aria-current={current?.to === n.to ? 'page' : undefined}>
              <n.icon />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="spacer" />
        <div className="workspace">
          <span className="avatar avatar-sm" aria-hidden="true">{initials(name)}</span>
          <div className="who">
            <div className="t-medium">{name}</div>
            <div className="t-caption">{me.user?.email ?? 'Operator token'}</div>
          </div>
          <button type="button" className="icon-btn" aria-label="Sign out" onClick={() => void signOut()}>
            <Icons.logout />
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="topbar-mark" aria-hidden="true"><LogoMark size={28} /></span>
          <div className="title">{current?.label ?? 'AsyncUp'}</div>
          <div className="search" aria-hidden="true">
            <Icons.search />
            <span className="t-small">Search ⌘K</span>
          </div>
          <ThemeToggle />
          <span className="avatar" aria-label={name}>{initials(name)}</span>
        </header>
        <main className="content">
          <Outlet />
        </main>
        <nav className="tabbar" aria-label="Primary (mobile)">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className="tab-item" aria-current={current?.to === n.to ? 'page' : undefined}>
              <n.icon />
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
