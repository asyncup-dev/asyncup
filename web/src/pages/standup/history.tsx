import { useState } from 'react';
import { MOOD_EMOJI } from '../../lib/api';
import { clock, longDate, monthOf, names, pct, shortDate } from '../../lib/format';
import { useRun, useRuns, useStandup } from '../../lib/standups';
import { useStandupId } from './layout';

const PAGE = 5;

export function HistoryPage() {
  const id = useStandupId();
  const standup = useStandup(id);
  const runs = useRuns(id, 90);
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'incomplete'>('all');
  const [shown, setShown] = useState(PAGE);
  const list = (runs.data ?? []).filter((r) => filter === 'all' || r.missing.length > 0);
  const selected = picked ?? list[0]?.date ?? null;
  const run = useRun(id, selected);
  const zone = standup.data?.schedule.timezone ?? 'UTC';
  const questionLabel = (q: string, i: number) => (standup.data?.questions[i] === q ? ['Yesterday', 'Today', 'Blockers'][i] ?? q : q) || q;
  return (
    <div className="history">
      <section className="card">
        <div className="card-head">
          <span className="t-medium grow">{list[0] ? `Runs · ${monthOf(list[0].date)}` : 'Runs'}</span>
          <label className="t-small secondary">
            Filter:{' '}
            <select className="input" style={{ height: 28, width: 'auto', display: 'inline-block' }} value={filter} onChange={(e) => { setFilter(e.target.value as 'all' | 'incomplete'); setPicked(null); }}>
              <option value="all">all</option>
              <option value="incomplete">incomplete</option>
            </select>
          </label>
        </div>
        <div className="runs-list" style={{ marginTop: 12 }}>
          {runs.isError ? <div className="alert">Could not load runs: {runs.error.message}</div> : null}
          {runs.data && list.length === 0 ? <div className="t-small muted" style={{ padding: 16 }}>No runs to show.</div> : null}
          {list.map((r) => (
            <button key={r.date} type="button" className="run-row" aria-current={r.date === selected ? 'true' : undefined} onClick={() => { setPicked(r.date); setShown(PAGE); }}>
              <span className="t-medium">{shortDate(r.date)}</span>
              <span className="progress-inline"><span className="progress" aria-hidden="true"><span style={{ display: 'block', height: '100%', width: `${pct(r.submitted, r.expected)}%`, background: 'var(--accent-primary)' }} /></span></span>
              <span className="t-small">{r.submitted} / {r.expected}</span>
              <span className={`badge ${r.status === 'closed' ? (r.missing.length ? 'badge-warning' : 'badge-success') : 'badge-info'}`}>{r.status === 'closed' ? (r.missing.length ? `${r.missing.length} missing` : 'Complete') : 'Open'}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="card">
        {!selected ? <div className="card-body t-small muted">Pick a run to see its answers.</div> : null}
        {run.isError ? <div className="card-body"><div className="alert">Could not load that run: {run.error.message}</div></div> : null}
        {run.data ? (
          <>
            <div className="card-head">
              <div className="grow">
                <div className="t-h3">{longDate(run.data.date)}</div>
                <div className="t-small secondary">
                  {run.data.submitted} of {run.data.expected} submitted · {run.data.status === 'closed' ? 'closed · wrap-up posted' : 'still open'}
                  {run.data.missing.length ? ` · missing ${names(run.data.missing)}` : ''}
                  {run.data.teamMood !== null ? ` · team mood ${run.data.teamMood}/5` : ''}
                </div>
              </div>
              <a className="btn btn-ghost" style={{ height: 28 }} href={`/api/v1/standups/${id}/export.csv?days=90`}>Export CSV</a>
            </div>
            <div className="card-body">
              {run.data.submissions.length === 0 ? <span className="t-small muted">No answers were submitted.</span> : null}
              {run.data.submissions.slice(0, shown).map((sub) => (
                <div key={sub.userName} className="submission">
                  <div className="person-row">
                    <span className="avatar avatar-sm" aria-hidden="true">{sub.displayName[0]}</span>
                    <span className="name t-medium">{sub.displayName}</span>
                    <span className="t-caption">{sub.mood ? `${MOOD_EMOJI[sub.mood] ?? ''} ` : ''}{clock(sub.submittedAt, zone)}{sub.late ? ' · late' : ''}{sub.editedAt ? ' · edited' : ''}</span>
                  </div>
                  <dl className="qa">
                    {sub.answers.map((a, i) => (
                      <div key={i} style={{ display: 'contents' }}>
                        <dt title={a.question}>{questionLabel(a.question, i)}</dt>
                        <dd>{a.answer || <span className="muted">—</span>}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
              {run.data.submissions.length > shown ? (
                <button type="button" className="btn btn-ghost" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, run.data.submissions.length - shown)} more submissions</button>
              ) : null}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
