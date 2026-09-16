import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';
import { averageSeries, BlockersChart, MoodChart, ParticipationChart } from '../components/charts';
import { api, type WeekPoint } from '../lib/api';
import { shortDate } from '../lib/format';
import { useBlockers } from '../lib/people';
import { useStandups } from '../lib/standups';

const WEEKS = [4, 8, 12] as const;

function avg(vals: (number | null)[]): number | null {
  const n = vals.filter((v): v is number => v !== null);
  return n.length ? Math.round((n.reduce((a, b) => a + b, 0) / n.length) * 10) / 10 : null;
}

/** Headline numbers: this period vs the previous one of the same length. */
export function headline(points: WeekPoint[]) {
  const half = Math.floor(points.length / 2);
  const recent = points.slice(half);
  const previous = points.slice(0, half);
  const part = avg(recent.map((p) => p.participationPct));
  const partPrev = avg(previous.map((p) => p.participationPct));
  const mood = avg(recent.map((p) => p.mood));
  const opened = recent.reduce((a, p) => a + p.blockersOpened, 0);
  const resolved = recent.reduce((a, p) => a + p.blockersResolved, 0);
  return { part: part === null ? null : Math.round(part), partDelta: part !== null && partPrev !== null ? Math.round(part - partPrev) : null, mood, opened, resolved };
}

export function ReportsPage() {
  const standups = useStandups();
  const [standupId, setStandupId] = useState<number | null>(null);
  const [weeks, setWeeks] = useState<(typeof WEEKS)[number]>(8);
  const targets = (standups.data ?? []).filter((s) => standupId === null || s.id === standupId);
  // Fetch double the window so the headline can compare against the previous period.
  const series = useQueries({
    queries: targets.map((s) => ({
      queryKey: ['insights', s.id, weeks * 2],
      queryFn: () => api<{ weeks: WeekPoint[] }>(`/standups/${s.id}/insights?weeks=${weeks * 2}`),
      select: (d: { weeks: WeekPoint[] }) => d.weeks,
      staleTime: 60_000,
    })),
  });
  const loaded = series.filter((q) => q.data).map((q) => q.data!);
  const full = averageSeries(loaded);
  const shown = full.slice(-weeks);
  const h = headline(full);
  const recent = useBlockers({ status: 'all', standupId });
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const raised = (recent.data ?? []).filter((b) => b.openedDate >= since).sort((a, b) => b.openedDate.localeCompare(a.openedDate));
  const ready = standups.data && loaded.length === targets.length;
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="t-h1" style={{ margin: 0 }}>Reports</h1>
          <div className="t-small muted">Last {weeks} weeks · {standupId === null ? 'all standups' : targets[0]?.name ?? ''}</div>
        </div>
        <div className="row">
          <select className="input" style={{ width: 'auto' }} aria-label="Standup" value={standupId ?? ''} onChange={(e) => setStandupId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">All standups</option>
            {standups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className="input" style={{ width: 'auto' }} aria-label="Period" value={weeks} onChange={(e) => setWeeks(Number(e.target.value) as (typeof WEEKS)[number])}>
            {WEEKS.map((w) => <option key={w} value={w}>Last {w} weeks</option>)}
          </select>
          {standupId !== null ? <a className="btn" href={`/api/v1/standups/${standupId}/export.csv?days=${weeks * 7}`}>Export CSV</a> : null}
        </div>
      </div>
      {standups.isError ? <div className="alert">Could not load standups: {standups.error.message}</div> : null}
      {series.some((q) => q.isError) ? <div className="alert">Some insight series could not be loaded.</div> : null}
      {!ready ? <p className="muted">Loading…</p> : null}
      {ready && targets.length === 0 ? <p className="muted">No standups to report on yet.</p> : null}
      {ready && targets.length > 0 ? (
        <div className="reports-grid">
          <section className="card section">
            <div className="t-medium">Participation</div>
            <div>
              <div className="t-h1">{h.part === null ? '—' : `${h.part}%`}</div>
              <div className="t-caption">{h.partDelta === null ? 'Not enough history to compare' : h.partDelta === 0 ? `Same as previous ${weeks} weeks` : `${h.partDelta > 0 ? '↑' : '↓'} ${Math.abs(h.partDelta)} pts vs previous ${weeks} weeks`}</div>
            </div>
            <ParticipationChart points={shown} />
          </section>
          <section className="card section">
            <div className="t-medium">Team mood</div>
            <div>
              <div className="t-h1">{h.mood === null ? '—' : `${h.mood} / 5`}</div>
              <div className="t-caption">{targets.some((s) => s.today) ? 'Averaged over the weeks that recorded a mood' : ''}</div>
            </div>
            <MoodChart points={shown} />
          </section>
          <section className="card section">
            <div className="t-medium">Blockers opened vs resolved</div>
            <div>
              <div className="t-h1">{h.opened} · {h.resolved}</div>
              <div className="t-caption">{h.opened - h.resolved > 0 ? `${h.opened - h.resolved} net open` : h.opened === 0 ? 'None opened' : 'All caught up'}</div>
            </div>
            <BlockersChart points={shown} />
          </section>
        </div>
      ) : null}
      <section className="card">
        <div className="card-head"><span className="t-h3 grow">Blockers raised · last 7 days</span></div>
        <div className="card-body">
          {recent.isError ? <div className="alert">Could not load blockers: {recent.error.message}</div> : null}
          {recent.data && raised.length === 0 ? <span className="t-small muted">No blockers raised this week.</span> : null}
          {raised.map((b) => (
            <div key={b.id} className="person-row">
              <span className="avatar avatar-sm" aria-hidden="true">{b.owner.displayName[0]}</span>
              <span style={{ width: 130 }} className="t-medium name">{b.owner.displayName}</span>
              <span style={{ width: 120 }} className="t-small secondary">{b.standup.name}</span>
              <span style={{ width: 90 }} className="t-small secondary">{shortDate(b.openedDate)}</span>
              <span className="name t-small">{b.text}</span>
              <span className={`badge ${b.status === 'resolved' ? 'badge-success' : ''}`}>{b.status}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
