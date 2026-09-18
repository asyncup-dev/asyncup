import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { AWAY_LABEL, MOOD_EMOJI } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { ago, clock, closesIn, daysLabel, names, pct, shortDate, zoneAbbr } from '../../lib/format';
import { useBlockerAction, useOpenBlockers, useRuns, useStandup, useToday } from '../../lib/standups';
import { useStandupId } from './layout';

function Ring({ value, total }: { value: number; total: number }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const filled = (pct(value, total) / 100) * c;
  return (
    <div className="ring" role="img" aria-label={`${value} of ${total} submitted`}>
      <svg width="112" height="112" viewBox="0 0 112 112">
        <circle cx="56" cy="56" r={r} fill="none" stroke="var(--bg-surface-2)" strokeWidth="10" />
        <circle cx="56" cy="56" r={r} fill="none" stroke="var(--accent-primary)" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${filled} ${c - filled}`} />
      </svg>
      <div className="label">
        <div className="t-h2">{value}/{total}</div>
        <div className="t-caption">submitted</div>
      </div>
    </div>
  );
}

export function OverviewPage() {
  const id = useStandupId();
  const standup = useStandup(id);
  const today = useToday(id);
  const runs = useRuns(id, 5);
  const blockers = useOpenBlockers(id);
  const me = useMe();
  const ack = useBlockerAction('acknowledge');
  const resolve = useBlockerAction('resolve');
  const [tick, setTick] = useState(Date.now());
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  const s = standup.data;
  const t = today.data;
  if (!s) return null;
  const zone = s.schedule.timezone;
  const canAct = !!me.data?.user?.userName;
  const onBlocker = async (m: typeof ack, blockerId: number) => {
    try {
      setActionError(null);
      await m.mutateAsync(blockerId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'That did not work.');
    }
  };
  return (
    <div className="overview">
      <div className="col">
        <section className="card">
          <div className="card-head">
            <span className="t-h3 grow">Today’s run{t ? ` · ${shortDate(t.date)}` : ''}</span>
            {t?.status === 'open' ? <span className="t-caption">Live · updated {ago(tick - today.dataUpdatedAt)}</span> : null}
          </div>
          <div className="card-body">
            {today.isError ? <div className="alert">Could not load today: {today.error.message}</div> : null}
            {t && !t.status ? <p className="muted" style={{ margin: 0 }}>No run today. {s.active ? `The next prompt goes out at ${s.schedule.promptTime} on the next scheduled day.` : 'This standup is archived.'}</p> : null}
            {t?.status ? (
              <div className="today-grid">
                <div>
                  <Ring value={t.submitted.length} total={t.expected} />
                  <div className="t-small secondary" style={{ textAlign: 'center', marginTop: 8 }}>{t.status === 'open' ? closesIn(s.schedule.deadlineTime, zone, new Date(tick)) : 'Closed'}</div>
                </div>
                <div className="cols-2">
                  <div>
                    <div className="row" style={{ marginBottom: 8 }}><span className="t-medium">Submitted</span><span className="badge">{t.submitted.length}</span></div>
                    <div className="people-list">
                      {t.submitted.map((p) => (
                        <div key={p.userName} className="person-row">
                          <span className="avatar avatar-sm" aria-hidden="true">{p.displayName[0]}</span>
                          <span className="name">{p.displayName}</span>
                          <span className="t-caption">{p.mood ? `${MOOD_EMOJI[p.mood] ?? ''} ` : ''}{clock(p.submittedAt, zone)}{p.late ? ' · late' : ''}</span>
                        </div>
                      ))}
                      {t.submitted.length === 0 ? <span className="t-small muted">Nobody yet</span> : null}
                    </div>
                  </div>
                  <div>
                    <div className="row" style={{ marginBottom: 8 }}><span className="t-medium">Waiting</span><span className="badge">{t.waiting.length}</span></div>
                    <div className="people-list">
                      {t.waiting.map((p) => (
                        <div key={p.userName} className="person-row">
                          <span className="avatar avatar-sm" aria-hidden="true">{p.displayName[0]}</span>
                          <span className="name">{p.displayName}</span>
                          <span className="t-caption">{p.remindedAt ? 'reminded' : p.mandatory ? '' : 'optional'}</span>
                        </div>
                      ))}
                      {t.away.map((p) => (
                        <div key={p.userName} className="person-row muted">
                          <span className="avatar avatar-sm" aria-hidden="true">{p.displayName[0]}</span>
                          <span className="name">{p.displayName}</span>
                          <span className="t-caption">{(p.reasonLabel ?? AWAY_LABEL[p.reason] ?? p.reason).toLowerCase()}</span>
                        </div>
                      ))}
                      {t.waiting.length + t.away.length === 0 ? <span className="t-small muted">Everyone is in</span> : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <span className="t-h3 grow">Recent runs</span>
            <Link to="/standups/$id/history" params={{ id: String(id) }} className="t-small">View history →</Link>
          </div>
          <div className="card-body">
            {runs.data?.length === 0 ? <span className="t-small muted">No runs yet</span> : null}
            {runs.data?.map((r) => (
              <div key={r.date} className="person-row">
                <span style={{ width: 110 }}>{shortDate(r.date)}</span>
                <span style={{ width: 60 }} className="t-small">{r.submitted} / {r.expected}</span>
                <span className="name t-small secondary">{r.missing.length ? names(r.missing) : '—'}</span>
                <span className={`badge ${r.status === 'closed' ? (r.missing.length ? 'badge-warning' : 'badge-success') : 'badge-info'}`}>{r.status === 'closed' ? (r.missing.length ? `${r.missing.length} missing` : 'Complete') : 'Open'}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="col">
        <section className="card">
          <div className="card-head"><span className="t-h3 grow">Open blockers</span><span className="badge">{blockers.data?.length ?? '…'}</span></div>
          <div className="card-body">
            {actionError ? <div className="alert" role="alert">{actionError}</div> : null}
            {blockers.data?.length === 0 ? <span className="t-small muted">None open</span> : null}
            {blockers.data?.map((b) => (
              <div key={b.id} className="blocker">
                <div className="person-row">
                  <span className="avatar avatar-sm" aria-hidden="true">{b.owner.displayName[0]}</span>
                  <span className="name t-medium">{b.owner.displayName}</span>
                  <span className={`badge ${b.escalatedAt ? 'badge-danger' : b.status === 'acknowledged' ? 'badge-info' : 'badge-warning'}`}>{b.escalatedAt ? 'Escalated' : b.status === 'acknowledged' ? 'Acknowledged' : `Since ${shortDate(b.openedDate)}`}</span>
                </div>
                <div className="t-small">{b.text}</div>
                {canAct ? (
                  <div className="row">
                    {b.status === 'open' && b.tags.some((x) => x.userName === me.data?.user?.userName) ? (
                      <button type="button" className="btn" style={{ height: 28 }} disabled={ack.isPending} onClick={() => void onBlocker(ack, b.id)}>Acknowledge</button>
                    ) : null}
                    <button type="button" className="btn btn-ghost" style={{ height: 28 }} disabled={resolve.isPending} onClick={() => void onBlocker(resolve, b.id)}>Resolve</button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
        <section className="card">
          <div className="card-head"><span className="t-h3 grow">Schedule</span><Link to="/standups/$id/settings" params={{ id: String(id) }} className="t-small">Edit</Link></div>
          <div className="card-body">
            <dl className="kv">
              <dt>Prompt</dt><dd>{s.schedule.promptTime} · participant-local</dd>
              <dt>Deadline</dt><dd>{s.schedule.deadlineTime} {zoneAbbr(zone)}</dd>
              <dt>Days</dt><dd>{daysLabel(s.schedule.days)}</dd>
              <dt>Reminder</dt><dd>{s.schedule.reminderMinutesBefore} min before deadline</dd>
              <dt>Escalation</dt><dd>{s.escalation.contact ? `After ${s.escalation.afterDays} days → ${s.escalation.contact.displayName}` : 'Off'}</dd>
              <dt>Mood</dt><dd>{s.mood.enabled ? (s.mood.anonymous ? 'On · anonymous' : 'On') : 'Off'}</dd>
            </dl>
          </div>
        </section>
      </div>
    </div>
  );
}
