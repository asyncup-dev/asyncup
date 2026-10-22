import { useState } from 'react';
import { daysLabel } from '../lib/format';
import { DAY_LABEL, DAYS, dateSpan, isoToday, POLICY_LABEL, STATUS_TONE, useAddOverride, useCancelOverride, useSaveWeek, useSchedule, weekToDays, type ScheduleTarget, type ScheduleView } from '../lib/schedule';

type WeekMode = 'follow' | 'custom' | 'adhoc';
type StandupDays = ScheduleView['standups'][number];

const modeOf = (workingDays: string | null): WeekMode => (workingDays === null ? 'follow' : workingDays === 'adhoc' ? 'adhoc' : 'custom');

/** One standup's days for the person: follow it, custom days, or ad hoc. */
function StandupDaysBlock({ standup, busy, onSave }: { standup: StandupDays; busy: boolean; onSave: (workingDays: string) => Promise<void> }) {
  const [mode, setMode] = useState<WeekMode>(modeOf(standup.workingDays));
  const [days, setDays] = useState<string[]>(weekToDays(standup.workingDays));
  const value = mode === 'follow' ? 'reset' : mode === 'adhoc' ? 'adhoc' : days.join(',');
  const dirty = value !== (standup.workingDays === null ? 'reset' : standup.workingDays);
  const runs = daysLabel(standup.days);
  const revert = () => {
    setMode(modeOf(standup.workingDays));
    setDays(weekToDays(standup.workingDays));
  };
  return (
    <section className="card" aria-label={`Days on ${standup.name}`} style={{ padding: 12, background: 'var(--bg-surface-2)', boxShadow: 'none', display: 'grid', gap: 10 }}>
      <div className="row">
        <span className="t-medium" style={{ flex: 1 }}>{standup.name}</span>
        <span className="t-caption">{POLICY_LABEL[standup.timeOffPolicy].split(' — ')[0]}</span>
      </div>
      <select className="input" aria-label={`Days on ${standup.name}`} style={{ width: 'auto', justifySelf: 'start' }} value={mode} onChange={(e) => setMode(e.target.value as WeekMode)}>
        <option value="follow">Follow the standup</option>
        <option value="custom">Custom days</option>
        <option value="adhoc">Ad hoc</option>
      </select>
      {mode === 'custom' ? (
        <div className="days">
          {DAYS.map((d) => (
            <button key={d} type="button" className="day" aria-pressed={days.includes(d)} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : DAYS.filter((x) => x === d || days.includes(x)))}>{DAY_LABEL[d]}</button>
          ))}
        </div>
      ) : null}
      <div className="t-caption">
        {mode === 'follow' ? `Expected on every day ${standup.name} runs: ${runs}.` : mode === 'adhoc' ? 'No fixed days — prompted only on dates marked working below.' : `${standup.name} runs ${runs}. Any other day ticked opens a run for this person.`}
      </div>
      {dirty ? (
        <div className="row">
          <button type="button" className="btn btn-primary" style={{ height: 28 }} disabled={busy || (mode === 'custom' && days.length === 0)} onClick={() => void onSave(value)}>Save days</button>
          <button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={revert}>Revert</button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The Edit schedule drawer: a person's days on each standup and their dated
 * overrides, for themselves or, from the Team page, for a manager.
 */
export function ScheduleDrawer({ target, title, onClose }: { target: ScheduleTarget; title: string; onClose: () => void }) {
  const schedule = useSchedule(target);
  const saveWeek = useSaveWeek(target);
  const add = useAddOverride(target);
  const cancel = useCancelOverride(target);
  const [form, setForm] = useState({ from: '', to: '', working: false, reason: '' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const s = schedule.data;
  const run = async (fn: () => Promise<{ message?: string } | unknown>) => {
    try {
      setError(null);
      setNotice(null);
      const r = (await fn()) as { message?: string } | undefined;
      if (r?.message) setNotice(r.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    }
  };
  const busy = saveWeek.isPending || add.isPending || cancel.isPending;
  const upcoming = (s?.overrides ?? []).filter((o) => o.status !== 'withdrawn');
  return (
    <div className="scrim right" role="presentation" onClick={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="grow">
            <h2 id="drawer-title" className="t-h3" style={{ margin: 0 }}>{title}</h2>
            <div className="t-small secondary">{s ? `${s.displayName} · ${s.policies.map((p) => p.name).join(', ') || 'no standups'}` : 'Loading…'}</div>
          </div>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onClose}>×</button>
        </div>
        <div className="drawer-body">
          {schedule.isError ? <div className="alert">Could not load the schedule: {schedule.error.message}</div> : null}
          {error ? <div className="alert" role="alert">{error}</div> : null}
          {notice ? <div className="toast" role="status">{notice}</div> : null}
          {s ? (
            <>
              <section style={{ display: 'grid', gap: 12 }}>
                <div className="t-label">Working days</div>
                {s.standups.length === 0 ? <div className="t-small muted">Not on any standup you manage.</div> : null}
                {s.standups.map((st) => (
                  <StandupDaysBlock key={`${st.standupId}:${st.workingDays}`} standup={st} busy={busy} onSave={(workingDays) => run(async () => { await saveWeek.mutateAsync({ standupId: st.standupId, workingDays }); return { message: `Days on ${st.name} saved.` }; })} />
                ))}
              </section>
              <section>
                <div className="row" style={{ marginBottom: 10 }}>
                  <span className="t-label grow">Days off and overrides</span>
                  <button type="button" className="btn btn-ghost" style={{ height: 26 }} disabled={busy} onClick={() => void run(() => add.mutateAsync({ date: isoToday(), working: false, reason: '' }))}>Mark away today</button>
                </div>
                {upcoming.length > 0 ? (
                  <div className="override-list">
                    {upcoming.map((o) => (
                      <div key={o.id} className="override-row">
                        <span className="grow">
                          <div className="t-medium">{dateSpan([o.date])}</div>
                          <div className="t-caption">{[o.reason, `set by ${o.setBy} via ${o.channel}`, o.decidedBy ? `${o.status} by ${o.decidedBy}` : null].filter(Boolean).join(' · ')}</div>
                        </span>
                        <span className={`badge ${o.status === 'active' ? (o.working ? 'badge-success' : 'badge-warning') : STATUS_TONE[o.status]}`}>{o.status === 'active' ? o.label : o.status}</span>
                        {o.status === 'active' || o.status === 'pending' ? <button type="button" className="icon-btn" aria-label={`Cancel ${dateSpan([o.date])}`} disabled={busy} onClick={() => void run(() => cancel.mutateAsync(o.date))}>×</button> : null}
                      </div>
                    ))}
                  </div>
                ) : <div className="t-small muted">Nothing coming up — the usual week applies.</div>}
                <form
                  className="row-wrap"
                  style={{ marginTop: 10, alignItems: 'center' }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!form.from) return;
                    void run(async () => {
                      const r = await add.mutateAsync({ from: form.from, to: form.to || form.from, working: form.working, reason: form.reason.trim() });
                      setForm({ from: '', to: '', working: false, reason: '' });
                      return r;
                    });
                  }}
                >
                  <input className="input" type="date" aria-label="From date" style={{ width: 150 }} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
                  <input className="input" type="date" aria-label="To date" style={{ width: 150 }} value={form.to} min={form.from} onChange={(e) => setForm({ ...form, to: e.target.value })} />
                  <select className="input" aria-label="Off or working" style={{ width: 'auto' }} value={form.working ? 'working' : 'off'} onChange={(e) => setForm({ ...form, working: e.target.value === 'working' })}>
                    <option value="off">Off</option>
                    <option value="working">Working</option>
                  </select>
                  <input className="input" aria-label="Reason" placeholder="Reason (optional)" style={{ flex: 1, minWidth: 120 }} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
                  <button type="submit" className="btn" style={{ height: 32 }} disabled={busy || !form.from}>Add</button>
                </form>
                <div className="t-caption" style={{ marginTop: 6 }}>{target === 'me' ? 'Past days can only be changed by a manager.' : 'Past dates change that run’s participation and are recorded with your name.'} Days off and working days apply to every standup {target === 'me' ? 'you are' : 'they are'} on.</div>
              </section>
            </>
          ) : null}
        </div>
        <div className="drawer-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
