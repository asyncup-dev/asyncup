import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { EmptyState } from '../components/empty-state';
import { api, type StandupSummary, type WeekPoint } from '../lib/api';
import { daysLabel, names, pct, shortDate } from '../lib/format';
import { spaceLabel, useOpenBlockers, useSpaceNames, useStandups } from '../lib/standups';

export function todayBadge(s: StandupSummary): { text: string; tone: string } {
  if (!s.today.status) return { text: 'Not started', tone: '' };
  if (s.today.status === 'closed') return { text: 'Wrapped up', tone: 'badge-success' };
  return { text: `${s.today.submitted} / ${s.today.expected} in`, tone: s.today.missing.length ? 'badge-warning' : 'badge-success' };
}

/** Participation this week vs last, averaged over the standups that ran. */
export function participation(series: (WeekPoint[] | undefined)[]): { now: number | null; delta: number | null } {
  const avg = (vals: (number | null)[]) => {
    const n = vals.filter((v): v is number => v !== null);
    return n.length ? Math.round(n.reduce((a, b) => a + b, 0) / n.length) : null;
  };
  const now = avg(series.map((w) => w?.[w.length - 1]?.participationPct ?? null));
  const prev = avg(series.map((w) => w?.[w.length - 2]?.participationPct ?? null));
  return { now, delta: now !== null && prev !== null ? now - prev : null };
}

export function StandupsPage() {
  const standups = useStandups();
  const spaces = useSpaceNames();
  const blockers = useOpenBlockers();
  const insights = useQueries({
    queries: (standups.data ?? []).map((s) => ({
      queryKey: ['insights', s.id, 2],
      queryFn: () => api<{ weeks: WeekPoint[] }>(`/standups/${s.id}/insights?weeks=2`),
      select: (d: { weeks: WeekPoint[] }) => d.weeks,
      staleTime: 60_000,
    })),
  });
  if (standups.isPending) return <p className="muted">Loading…</p>;
  if (standups.isError) return <div className="alert">Could not load standups: {standups.error.message}</div>;
  const list = standups.data;
  const open = list.filter((s) => s.today.status === 'open');
  const submitted = list.reduce((n, s) => n + s.today.submitted, 0);
  const expected = list.reduce((n, s) => n + s.today.expected, 0);
  const missing = open.flatMap((s) => s.today.missing);
  const part = participation(insights.map((q) => q.data));
  const escalated = (blockers.data ?? []).filter((b) => b.escalatedAt).length;
  const today = list[0]?.today.date;
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="t-h1" style={{ margin: 0 }}>Standups</h1>
          <div className="t-small muted">
            {list.length ? `${today ? `${shortDate(today)} · ` : ''}${list.length} standup${list.length === 1 ? '' : 's'} · ${open.length} open today` : 'Nothing running yet'}
          </div>
        </div>
        {list.length ? <Link to="/setup/template" className="btn btn-primary">New standup</Link> : null}
      </div>
      {list.length === 0 ? (
        <EmptyState title="No standups yet" action={<Link to="/setup" className="btn btn-primary">Set up your first standup</Link>}>
          Pick a template, choose the Chat space it reports to and add the people to prompt. About two minutes once Google Chat is connected.
        </EmptyState>
      ) : (
        <>
          <div className="stats">
            <div className="stat card">
              <div className="t-label">Submitted today</div>
              <div className="value">{submitted} / {expected}</div>
              <div className="t-caption">{expected - submitted > 0 ? `${expected - submitted} still waiting` : open.length ? 'Everyone is in' : 'No run open'}</div>
            </div>
            <div className="stat card">
              <div className="t-label">Participation · this week</div>
              <div className="value">{part.now === null ? '—' : `${part.now}%`}</div>
              <div className="t-caption">{part.delta === null ? 'Not enough history yet' : part.delta === 0 ? 'Same as last week' : `${part.delta > 0 ? '↑' : '↓'} ${Math.abs(part.delta)} pts vs last week`}</div>
            </div>
            <div className="stat card">
              <div className="t-label">Open blockers</div>
              <div className="value">{blockers.data ? blockers.data.length : '—'}</div>
              <div className="t-caption">{blockers.data ? (escalated ? `${escalated} escalated` : blockers.data.length ? 'None escalated' : 'All clear') : blockers.isError ? 'Could not load' : 'Loading…'}</div>
            </div>
            <div className="stat card">
              <div className="t-label">Missing today</div>
              <div className="value">{missing.length}</div>
              <div className="t-caption">{missing.length ? names(missing) : open.length ? 'Nobody' : 'No run open'}</div>
            </div>
          </div>
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th className="t-label">Standup</th>
                  <th className="t-label">Schedule</th>
                  <th className="t-label">Space</th>
                  <th className="t-label">Today</th>
                  <th className="t-label">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => {
                  const badge = todayBadge(s);
                  return (
                    <tr key={s.id}>
                      <td data-label="Standup">
                        <Link to="/standups/$id" params={{ id: String(s.id) }} className="row-link">
                          <div className="t-strong">{s.name}</div>
                          <div className="t-caption">{s.people.total} {s.people.total === 1 ? 'person' : 'people'}</div>
                        </Link>
                      </td>
                      <td data-label="Schedule" className="t-small secondary">
                        {s.schedule.promptTime}–{s.schedule.deadlineTime} {s.schedule.timezone}
                        <div className="t-caption">{daysLabel(s.schedule.days)}</div>
                      </td>
                      <td data-label="Space" className="t-small secondary">{spaceLabel(spaces.data, s.spaceName)}</td>
                      <td data-label="Today">
                        {s.today.status ? (
                          <span className="progress-inline">
                            <span className="progress" aria-hidden="true"><span style={{ display: 'block', height: '100%', width: `${pct(s.today.submitted, s.today.expected)}%`, background: 'var(--accent-primary)' }} /></span>
                            <span className="t-small">{s.today.submitted} / {s.today.expected}</span>
                          </span>
                        ) : (
                          <span className="t-small muted">—</span>
                        )}
                      </td>
                      <td data-label="Status">
                        <span className={`badge ${badge.tone}`}>{badge.text}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
