import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog';
import { ScheduleDrawer } from '../components/schedule-drawer';
import { roleOf, useParticipantPatch, useParticipantRemove, usePeople, type PersonRow } from '../lib/people';
import { dateSpan, groupRequests, useDecide, useRequests } from '../lib/schedule';

type Filter = 'everyone' | 'managers' | 'away' | 'requests';
const FILTER_LABEL: Record<Filter, string> = { everyone: 'Everyone', managers: 'Managers', away: 'Away', requests: 'Requests' };

export function TeamPage() {
  const people = usePeople();
  const patch = useParticipantPatch();
  const remove = useParticipantRemove();
  const [filter, setFilter] = useState<Filter>('everyone');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ person: PersonRow; standup: { id: number; name: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scheduleFor, setScheduleFor] = useState<PersonRow | null>(null);
  const [declining, setDeclining] = useState<{ key: string; note: string } | null>(null);
  const requests = useRequests(true);
  const decide = useDecide();
  const groups = groupRequests(requests.data ?? []);
  const matches = (p: PersonRow, f: Filter) => f === 'everyone' || (f === 'managers' ? roleOf(p) === 'Manager' : f === 'away' ? p.onVacation : false);
  const rows = (people.data ?? []).filter((p) => matches(p, filter));
  const standupCount = new Set((people.data ?? []).flatMap((p) => p.standups.map((s) => s.id))).size;
  const act = async (fn: () => Promise<unknown>) => {
    setMenuFor(null);
    try {
      setError(null);
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    }
  };
  if (people.isError) return <div className="alert">Could not load the team: {people.error.message}</div>;
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="t-h1" style={{ margin: 0 }}>Team</h1>
          <div className="t-small muted">{people.data ? `${people.data.length} ${people.data.length === 1 ? 'person' : 'people'} across ${standupCount} standup${standupCount === 1 ? '' : 's'}` : 'Loading…'}</div>
        </div>
      </div>
      <div className="chip-tabs" role="tablist" aria-label="Filter">
        {(['everyone', 'managers', 'away', 'requests'] as const).map((f) => (
          <button key={f} type="button" role="tab" className="chip-tab" aria-pressed={filter === f} aria-selected={filter === f} onClick={() => setFilter(f)}>
            {FILTER_LABEL[f]} · {f === 'requests' ? groups.length : (people.data ?? []).filter((p) => matches(p, f)).length}
          </button>
        ))}
      </div>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      {filter === 'requests' ? (
        <div className="card" style={{ padding: 0 }}>
          {requests.isError ? <div className="alert" style={{ margin: 16 }}>Could not load requests: {requests.error.message}</div> : null}
          {requests.data && groups.length === 0 ? <div className="t-small muted" style={{ padding: 16 }}>No time-off requests waiting. Requests appear here when a standup’s time-off policy needs a manager’s approval.</div> : null}
          {groups.map((g) => (
            <div key={g.key} className="request">
              <span className="avatar avatar-sm" aria-hidden="true">{g.person[0]}</span>
              <span className="grow" style={{ flex: 1, minWidth: 0 }}>
                <div className="t-strong">{g.person}</div>
                <div>{dateSpan(g.dates)} · {g.dates.length} day{g.dates.length === 1 ? '' : 's'} {g.working ? 'working' : 'off'}</div>
                <div className="t-caption">{g.reason ? `“${g.reason}” · ` : ''}requested via {g.channel} · lapses at the run’s deadline if unanswered</div>
                {declining?.key === g.key ? (
                  <div className="row" style={{ marginTop: 8 }}>
                    <input className="input" aria-label="Reason for declining" placeholder="Why not? (sent to the person)" value={declining.note} onChange={(e) => setDeclining({ key: g.key, note: e.target.value })} />
                    <button type="button" className="btn btn-danger" style={{ height: 32 }} disabled={decide.isPending} onClick={() => void act(async () => { await decide.mutateAsync({ ids: g.ids, approve: false, note: declining.note.trim() || undefined }); setDeclining(null); })}>Send decline</button>
                  </div>
                ) : null}
              </span>
              <button type="button" className="btn btn-ghost" disabled={decide.isPending} onClick={() => setDeclining(declining?.key === g.key ? null : { key: g.key, note: '' })}>Decline…</button>
              <button type="button" className="btn btn-primary" disabled={decide.isPending} onClick={() => void act(() => decide.mutateAsync({ ids: g.ids, approve: true }))}>Approve</button>
            </div>
          ))}
        </div>
      ) : (
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th className="t-label">Person</th>
              <th className="t-label">Role</th>
              <th className="t-label">Standups</th>
              <th className="t-label">Schedule</th>
              <th className="t-label">Timezone</th>
              <th className="t-label">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {people.data && rows.length === 0 ? <tr><td colSpan={7} className="t-small muted">Nobody matches this filter.</td></tr> : null}
            {rows.map((p) => (
              <tr key={p.userName}>
                <td data-label="Person">
                  <span className="person-row">
                    <span className="avatar" aria-hidden="true">{p.displayName[0]}</span>
                    <span>
                      <div className="t-medium">{p.displayName}</div>
                      <div className="t-caption">{p.email ?? p.userName}</div>
                    </span>
                  </span>
                </td>
                <td data-label="Role"><span className={`badge ${roleOf(p) === 'Manager' ? 'badge-info' : ''}`}>{roleOf(p)}</span></td>
                <td data-label="Standups" className="t-small">{p.standups.map((s) => `${s.name}${s.mandatory ? '' : ' (optional)'}`).join(' · ') || '—'}</td>
                <td data-label="Schedule" className="t-small">{p.workingDaysLabel === 'Follows the standup' ? 'Standup days' : p.workingDaysLabel}</td>
                <td data-label="Timezone" className="t-small secondary">{p.timezone ?? '—'}</td>
                <td data-label="Status"><span className={`badge ${p.onVacation ? 'badge-warning' : 'badge-success'}`}>{p.onVacation ? 'Away' : 'Active'}</span></td>
                <td>
                  <div className="menu" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button type="button" className="icon-btn" aria-label={`Actions for ${p.displayName}`} aria-expanded={menuFor === p.userName} onClick={() => setMenuFor(menuFor === p.userName ? null : p.userName)}>⋯</button>
                    {menuFor === p.userName ? (
                      <div className="menu-list" role="menu">
                        {p.standups.map((s) => (
                          <div key={s.id} style={{ display: 'contents' }}>
                            <div className="t-label" style={{ padding: '6px 12px 2px' }}>{s.name}</div>
                            <button type="button" role="menuitem" onClick={() => void act(() => patch.mutateAsync({ standupId: s.id, userName: p.userName, patch: { mandatory: !s.mandatory } }))}>{s.mandatory ? 'Make optional' : 'Make mandatory'}</button>
                            <button type="button" role="menuitem" onClick={() => void act(() => patch.mutateAsync({ standupId: s.id, userName: p.userName, patch: { admin: !s.admin } }))}>{s.admin ? 'Remove as manager' : 'Make manager'}</button>
                            <button type="button" role="menuitem" className="danger" onClick={() => { setMenuFor(null); setConfirm({ person: p, standup: s }); }}>Remove from {s.name}</button>
                          </div>
                        ))}
                        <div className="t-label" style={{ padding: '6px 12px 2px' }}>Everywhere</div>
                        <button type="button" role="menuitem" onClick={() => { setMenuFor(null); setScheduleFor(p); }}>Edit schedule…</button>
                        <button type="button" role="menuitem" onClick={() => void act(async () => { for (const s of p.standups) await patch.mutateAsync({ standupId: s.id, userName: p.userName, patch: { onVacation: !p.onVacation } }); })}>{p.onVacation ? 'Mark as back' : 'Mark as away'}</button>
                      </div>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      <p className="t-small muted" style={{ margin: 0 }}>Roles: Admins manage the workspace. Managers see reports and manage their own standups without Workspace-admin rights. Members get the personal console.</p>
      {scheduleFor ? <ScheduleDrawer target={{ userName: scheduleFor.userName }} title="Edit schedule" onClose={() => setScheduleFor(null)} /> : null}
      {confirm ? (
        <ConfirmDialog
          title={`Remove ${confirm.person.displayName} from ${confirm.standup.name}?`}
          body="They stop being prompted from the next run. Their past answers stay in the history."
          confirmLabel="Remove"
          danger
          onConfirm={() => act(() => remove.mutateAsync({ standupId: confirm.standup.id, userName: confirm.person.userName })).then(() => setConfirm(null))}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </>
  );
}
