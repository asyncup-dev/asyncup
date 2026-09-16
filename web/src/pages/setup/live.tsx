import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { LogoLockup } from '../../components/logo';
import { api, type StandupSummary, type TodayRun } from '../../lib/api';

export const LIVE_POLL_MS = 5_000;

function timeOf(iso: string, zone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: zone }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

export function LivePage() {
  const search = useSearch({ strict: false }) as { standup?: number };
  const id = Number(search.standup);
  const standup = useQuery({ queryKey: ['standup', id], queryFn: () => api<StandupSummary>(`/standups/${id}`), enabled: Number.isFinite(id) && id > 0 });
  const today = useQuery({
    queryKey: ['today', id],
    queryFn: () => api<TodayRun>(`/standups/${id}/runs/today`),
    enabled: Number.isFinite(id) && id > 0,
    refetchInterval: (q) => (q.state.data?.status === 'open' ? LIVE_POLL_MS : false),
  });
  const s = standup.data;
  const t = today.data;
  if (standup.isError) return <div className="alert" style={{ margin: 24 }}>Could not load the standup: {standup.error.message}</div>;
  if (!s || !t) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;
  const done = t.submitted.length;
  const pct = t.expected ? Math.round((done / t.expected) * 100) : 0;
  const running = t.status === 'open';
  return (
    <div>
      <div className="setup-brandbar"><LogoLockup /></div>
      <div className="setup-centered" style={{ maxWidth: 680 }}>
        <span className="check-circle" aria-hidden="true">✓</span>
        <div>
          <h1 className="t-display" style={{ margin: 0 }}>{s.name} is {running ? 'live' : 'ready'}</h1>
          <p className="lede t-body-lg" style={{ marginTop: 12 }}>
            {running
              ? `${t.expected} ${t.expected === 1 ? 'person' : 'people'} just got a DM from AsyncUp. Answers post to the space under today’s thread as they come in — watch it happen.`
              : `Nothing has been sent yet. The first prompt goes out at ${s.schedule.promptTime} ${s.schedule.timezone} on the next scheduled day.`}
          </p>
        </div>
        <div className="card section">
          <div className="row">
            <span className="t-strong grow">Today’s run</span>
            <span className={`badge ${running ? 'badge-success' : ''}`}>{running ? `${done} of ${t.expected} submitted` : t.status === 'closed' ? 'Wrapped up' : 'Not started'}</span>
            {running ? <span className="t-caption">Live</span> : null}
          </div>
          <div className="progress" aria-label="Progress"><div style={{ width: `${pct}%` }} /></div>
          {t.submitted.map((p) => (
            <div key={p.userName} className="live-row">
              <span className="avatar avatar-sm" aria-hidden="true">{p.displayName[0]}</span>
              <span className="t-medium" style={{ width: 130 }}>{p.displayName}</span>
              <span className="t-small secondary grow">Submitted {timeOf(p.submittedAt, s.schedule.timezone)}</span>
              <span className="badge badge-success">Done</span>
            </div>
          ))}
          {t.waiting.map((p) => (
            <div key={p.userName} className="live-row">
              <span className="avatar avatar-sm" aria-hidden="true">{p.displayName[0]}</span>
              <span className="t-medium" style={{ width: 130 }}>{p.displayName}</span>
              <span className="t-small secondary grow">{p.remindedAt ? 'Reminded' : 'Prompted'}</span>
              <span className="badge">{p.mandatory ? 'Waiting' : 'Optional'}</span>
            </div>
          ))}
          {t.away.map((p) => (
            <div key={p.userName} className="live-row">
              <span className="avatar avatar-sm" aria-hidden="true">{p.displayName[0]}</span>
              <span className="t-medium" style={{ width: 130 }}>{p.displayName}</span>
              <span className="t-small secondary grow">{p.reason === 'vacation' ? 'On vacation' : 'Skipped today'}</span>
              <span className="badge">Away</span>
            </div>
          ))}
        </div>
        <div className="card section">
          <div className="t-strong">What happens next</div>
          <ul className="t-small secondary" style={{ margin: 0, paddingLeft: 18 }}>
            <li>{s.schedule.deadlineTime} — the run closes and a wrap-up posts to the space naming anyone missing.</li>
            <li>Next scheduled day at {s.schedule.promptTime} — everyone is prompted again, in their own timezone.</li>
            <li>Blockers open automatically from answers; tag a teammate to work them as items.</li>
          </ul>
        </div>
        <div className="row-wrap">
          <Link to="/standups" className="btn btn-primary btn-lg">Go to the console</Link>
          <Link to="/standups" className="btn btn-lg">See all standups</Link>
        </div>
      </div>
    </div>
  );
}
