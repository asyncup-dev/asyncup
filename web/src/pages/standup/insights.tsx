import { useQueries } from '@tanstack/react-query';
import { BlockersChart, MoodChart, ParticipationChart } from '../../components/charts';
import { api, type RunDetail } from '../../lib/api';
import { pct } from '../../lib/format';
import { headline } from '../reports';
import { useInsights, useRuns, useStandup } from '../../lib/standups';
import { useStandupId } from './layout';

const DETAIL_RUNS = 10;

export function InsightsPage() {
  const id = useStandupId();
  const standup = useStandup(id);
  const weeks = useInsights(id, 16);
  const runs = useRuns(id, 40);
  const closed = (runs.data ?? []).filter((r) => r.status === 'closed');
  // Late counts need the full submissions; ten runs is enough signal without ten dozen requests.
  const details = useQueries({
    queries: closed.slice(0, DETAIL_RUNS).map((r) => ({ queryKey: ['run', id, r.date], queryFn: () => api<RunDetail>(`/standups/${id}/runs/${r.date}`), staleTime: 300_000 })),
  });
  const s = standup.data;
  if (!s) return null;
  const h = headline(weeks.data ?? []);
  const shown = (weeks.data ?? []).slice(-8);
  const people = s.participants.map((p) => {
    const missed = closed.filter((r) => r.missing.some((m) => m.userName === p.userName)).length;
    const late = details.reduce((n, q) => n + (q.data?.submissions.some((x) => x.userName === p.userName && x.late) ? 1 : 0), 0);
    return { ...p, missed, late, participation: closed.length ? pct(closed.length - missed, closed.length) : null };
  }).sort((a, b) => (b.participation ?? -1) - (a.participation ?? -1));
  const lateTotal = details.reduce((n, q) => n + (q.data?.submissions.filter((x) => x.late).length ?? 0), 0);
  const subsTotal = details.reduce((n, q) => n + (q.data?.submissions.length ?? 0), 0);
  return (
    <>
      <div className="stats">
        <div className="stat card"><div className="t-label">Participation</div><div className="value">{h.part === null ? '—' : `${h.part}%`}</div><div className="t-caption">{h.partDelta === null ? 'Last 8 weeks' : `${h.partDelta >= 0 ? '↑' : '↓'} ${Math.abs(h.partDelta)} pts vs previous 8 weeks`}</div></div>
        <div className="stat card"><div className="t-label">Late submissions</div><div className="value">{subsTotal ? `${pct(lateTotal, subsTotal)}%` : '—'}</div><div className="t-caption">{subsTotal ? `${lateTotal} of ${subsTotal} in the last ${Math.min(DETAIL_RUNS, closed.length)} runs` : 'No closed runs yet'}</div></div>
        <div className="stat card"><div className="t-label">Team mood</div><div className="value">{h.mood === null ? '—' : `${h.mood} / 5`}</div><div className="t-caption">{s.mood.anonymous ? 'Anonymous · team average only' : 'Average of everyone who picked one'}</div></div>
        <div className="stat card"><div className="t-label">Blockers</div><div className="value">{h.opened} · {h.resolved}</div><div className="t-caption">opened · resolved, last 8 weeks</div></div>
      </div>
      <div className="insights">
        <section className="card">
          <div className="card-head"><span className="t-h3 grow">Participation by person</span><span className="t-caption">{closed.length} closed run{closed.length === 1 ? '' : 's'}</span></div>
          <div className="card-body">
            {runs.isError ? <div className="alert">Could not load runs: {runs.error.message}</div> : null}
            {people.length === 0 ? <span className="t-small muted">No participants yet.</span> : null}
            {people.map((p) => (
              <div key={p.userName} className="bar-row">
                <span className="avatar avatar-sm" aria-hidden="true">{p.displayName[0]}</span>
                <span className="t-medium name">{p.displayName}</span>
                <span className="progress" aria-hidden="true"><span style={{ display: 'block', height: '100%', width: `${p.participation ?? 0}%`, background: 'var(--accent-primary)' }} /></span>
                <span className="t-small">{p.participation === null ? '—' : `${p.participation}%`}</span>
                <span className="t-caption">{p.late} late</span>
                <span className="t-caption">{p.onVacation ? 'away' : !p.mandatory ? 'optional' : p.missed === 0 && closed.length ? 'Every run' : p.missed ? `missing ${p.missed}` : ''}</span>
              </div>
            ))}
          </div>
        </section>
        <div className="col" style={{ display: 'grid', gap: 20 }}>
          <section className="card section">
            <div className="row"><span className="t-medium grow">Team mood{s.mood.anonymous ? ' · anonymous' : ''}</span></div>
            {weeks.isError ? <div className="alert">Could not load insights: {weeks.error.message}</div> : <MoodChart points={shown} />}
          </section>
          <section className="card section">
            <div className="t-medium">Participation</div>
            <ParticipationChart points={shown} />
          </section>
          <section className="card section">
            <div className="t-medium">Blockers opened vs resolved</div>
            <BlockersChart points={shown} />
          </section>
        </div>
      </div>
    </>
  );
}
