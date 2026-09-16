import { useState } from 'react';
import { useMe } from '../lib/auth';
import { shortDate } from '../lib/format';
import { ageOf, useBlockerUpdate, useBlockers } from '../lib/people';
import { useBlockerAction, useStandups } from '../lib/standups';

const STATUSES = ['open', 'acknowledged', 'resolved'] as const;

export function BlockersPage() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('open');
  const [standupId, setStandupId] = useState<number | null>(null);
  const [owner, setOwner] = useState('');
  const [escalatedOnly, setEscalatedOnly] = useState(false);
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const standups = useStandups();
  const all = useBlockers({ status: 'all' });
  const list = useBlockers({ status, standupId, owner: owner || undefined });
  const me = useMe();
  const ack = useBlockerAction('acknowledge');
  const resolve = useBlockerAction('resolve');
  const update = useBlockerUpdate();
  const canAct = !!me.data?.user?.userName;
  const counts = { open: 0, acknowledged: 0, resolved: 0 };
  for (const b of all.data ?? []) counts[b.status] += 1;
  const owners = [...new Map((all.data ?? []).map((b) => [b.owner.userName, b.owner])).values()];
  const rows = (list.data ?? []).filter((b) => !escalatedOnly || b.escalatedAt).sort((a, b) => a.openedDate.localeCompare(b.openedDate));
  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    }
  };
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="t-h1" style={{ margin: 0 }}>Blockers</h1>
          <div className="t-small muted">{status === 'resolved' ? 'Resolved' : status === 'acknowledged' ? 'Acknowledged' : 'Open'} across all standups · oldest first</div>
        </div>
      </div>
      <div className="row-wrap" style={{ alignItems: 'center' }}>
        <div className="chip-tabs" role="tablist" aria-label="Status">
          {STATUSES.map((s) => (
            <button key={s} type="button" role="tab" className="chip-tab" aria-pressed={status === s} aria-selected={status === s} onClick={() => setStatus(s)}>
              {s[0]!.toUpperCase() + s.slice(1)} · {counts[s]}
            </button>
          ))}
        </div>
        <span className="muted">|</span>
        <select className="input" style={{ width: 'auto', height: 30 }} aria-label="Standup" value={standupId ?? ''} onChange={(e) => setStandupId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">All standups</option>
          {standups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="input" style={{ width: 'auto', height: 30 }} aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Any owner</option>
          {owners.map((o) => <option key={o.userName} value={o.userName}>{o.displayName}</option>)}
        </select>
        <button type="button" className="chip-tab" aria-pressed={escalatedOnly} onClick={() => setEscalatedOnly(!escalatedOnly)}>Escalated only</button>
      </div>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      {list.isError ? <div className="alert">Could not load blockers: {list.error.message}</div> : null}
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th className="t-label">Blocker</th>
              <th className="t-label">Standup</th>
              <th className="t-label">Owner</th>
              <th className="t-label">Age</th>
              <th className="t-label">Status</th>
              <th className="t-label">Tagged</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data && rows.length === 0 ? (
              <tr><td colSpan={7} className="t-small muted">Nothing here{status === 'open' ? ' — no open blockers' : ''}.</td></tr>
            ) : null}
            {rows.map((b) => (
              <tr key={b.id}>
                <td data-label="Blocker">
                  <div className="t-medium">{b.text}</div>
                  {b.updates.length ? <div className="t-caption">Last update: {b.updates[b.updates.length - 1]!.text}</div> : null}
                  {noteFor === b.id ? (
                    <div className="row" style={{ marginTop: 8 }}>
                      <input className="input" aria-label="Update text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed?" maxLength={200} />
                      <button type="button" className="btn" style={{ height: 28 }} disabled={!note.trim() || update.isPending} onClick={() => void run(async () => { await update.mutateAsync({ id: b.id, text: note.trim() }); setNote(''); setNoteFor(null); })}>Post</button>
                      <button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={() => setNoteFor(null)}>Cancel</button>
                    </div>
                  ) : null}
                </td>
                <td data-label="Standup" className="t-small">{b.standup.name}</td>
                <td data-label="Owner">
                  <span className="person-row"><span className="avatar avatar-sm" aria-hidden="true">{b.owner.displayName[0]}</span><span className="t-small">{b.owner.displayName}</span></span>
                </td>
                <td data-label="Age" className="t-small secondary">{b.resolvedDate ? `Resolved ${shortDate(b.resolvedDate)}` : ageOf(b.openedDate)}</td>
                <td data-label="Status">
                  <span className={`badge ${b.status === 'resolved' ? 'badge-success' : b.escalatedAt ? 'badge-danger' : b.status === 'acknowledged' ? 'badge-info' : 'badge-warning'}`}>
                    {b.status === 'resolved' ? 'Resolved' : b.escalatedAt ? 'Escalated' : b.status === 'acknowledged' ? 'Acknowledged' : 'Open'}
                  </span>
                </td>
                <td data-label="Tagged">
                  {b.tags.length ? (
                    <span className="avatars" aria-label={`Tagged: ${b.tags.map((t) => t.displayName).join(', ')}`}>
                      {b.tags.map((t) => <span key={t.userName} className="avatar avatar-sm" title={t.displayName}>{t.displayName[0]}</span>)}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {canAct && b.status !== 'resolved' ? (
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      {b.status === 'open' && b.tags.some((t) => t.userName === me.data?.user?.userName) ? (
                        <button type="button" className="btn" style={{ height: 28 }} disabled={ack.isPending} onClick={() => void run(() => ack.mutateAsync(b.id))}>Acknowledge</button>
                      ) : null}
                      <button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={() => { setNoteFor(b.id); setNote(''); }}>Update</button>
                      <button type="button" className="btn btn-ghost" style={{ height: 28 }} disabled={resolve.isPending} onClick={() => void run(() => resolve.mutateAsync(b.id))}>Resolve</button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
