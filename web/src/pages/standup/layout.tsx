import { Link, Outlet, useParams, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { daysLabel, zoneAbbr } from '../../lib/format';
import { RUN_NOW_COPY, spaceLabel, useNudge, useRunNow, useSpaceNames, useStandup } from '../../lib/standups';

export function useStandupId(): number {
  const { id } = useParams({ strict: false }) as { id?: string };
  return Number(id);
}

const TABS = [
  { to: '/standups/$id', label: 'Overview', exact: true },
  { to: '/standups/$id/history', label: 'History' },
  { to: '/standups/$id/insights', label: 'Insights' },
  { to: '/standups/$id/settings', label: 'Settings' },
] as const;

export function StandupLayout() {
  const id = useStandupId();
  const standup = useStandup(id);
  const spaces = useSpaceNames();
  const runNow = useRunNow(id);
  const nudge = useNudge(id);
  const [notice, setNotice] = useState<string | null>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (standup.isPending) return <p className="muted">Loading…</p>;
  if (standup.isError) return <div className="alert">Could not load this standup: {standup.error.message}</div>;
  const s = standup.data;
  const base = `/app/standups/${id}`;
  const status = s.today.status === 'open' ? { text: `Run open · ${s.today.submitted} / ${s.today.expected} in`, tone: 'badge-success' } : s.today.status === 'closed' ? { text: 'Wrapped up today', tone: '' } : s.active ? { text: 'Next run on schedule', tone: '' } : { text: 'Archived', tone: 'badge-warning' };
  const act = async (m: typeof runNow, copy: (r: string) => string) => {
    try {
      const { result } = await m.mutateAsync();
      setNotice(copy(result));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'That did not work.');
    }
  };
  return (
    <>
      <div className="standup-header">
        <div className="grow">
          <div className="row">
            <h1 className="t-h1" style={{ margin: 0 }}>{s.name}</h1>
            <span className={`badge ${status.tone}`}>{status.text}</span>
          </div>
          <div className="t-small muted">
            {spaceLabel(spaces.data, s.spaceName)} · {s.schedule.promptTime} – {s.schedule.deadlineTime} {zoneAbbr(s.schedule.timezone)} · {daysLabel(s.schedule.days)} · {s.people.total} participant{s.people.total === 1 ? '' : 's'}
          </div>
        </div>
        {s.permissions.manage ? (
          <>
            <button type="button" className="btn btn-primary" disabled={runNow.isPending} onClick={() => void act(runNow, (r) => RUN_NOW_COPY[r] ?? r)}>Run now</button>
            <button type="button" className="btn" disabled={nudge.isPending || s.today.status !== 'open'} onClick={() => void act(nudge, () => 'Reminder sent to everyone still expected today.')}>Nudge everyone</button>
            <a className="btn btn-ghost" href={`/api/v1/standups/${id}/export.csv?days=90`}>Export CSV</a>
          </>
        ) : null}
      </div>
      {notice ? <div className="toast" role="status">{notice} <button type="button" className="btn btn-ghost" style={{ height: 24 }} onClick={() => setNotice(null)}>Dismiss</button></div> : null}
      <nav className="tabs" aria-label="Standup sections">
        {TABS.map((t) => {
          const href = t.to.replace('$id', String(id));
          const current = 'exact' in t ? pathname === `/app${href}` || pathname === `${base}/` : pathname.startsWith(`/app${href}`);
          return (
            <Link key={t.to} to={t.to} params={{ id: String(id) }} className="tab" aria-current={current ? 'page' : undefined}>{t.label}</Link>
          );
        })}
      </nav>
      <Outlet />
    </>
  );
}
