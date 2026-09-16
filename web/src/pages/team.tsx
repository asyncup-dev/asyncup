import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog';
import { roleOf, useParticipantPatch, useParticipantRemove, usePeople, type PersonRow } from '../lib/people';

type Filter = 'everyone' | 'managers' | 'away';

export function TeamPage() {
  const people = usePeople();
  const patch = useParticipantPatch();
  const remove = useParticipantRemove();
  const [filter, setFilter] = useState<Filter>('everyone');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ person: PersonRow; standup: { id: number; name: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = (people.data ?? []).filter((p) => filter === 'everyone' || (filter === 'managers' ? roleOf(p) === 'Manager' : p.onVacation));
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
        {(['everyone', 'managers', 'away'] as const).map((f) => (
          <button key={f} type="button" role="tab" className="chip-tab" aria-pressed={filter === f} aria-selected={filter === f} onClick={() => setFilter(f)}>
            {f === 'everyone' ? 'Everyone' : f === 'managers' ? 'Managers' : 'Away'} · {(people.data ?? []).filter((p) => f === 'everyone' || (f === 'managers' ? roleOf(p) === 'Manager' : p.onVacation)).length}
          </button>
        ))}
      </div>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th className="t-label">Person</th>
              <th className="t-label">Role</th>
              <th className="t-label">Standups</th>
              <th className="t-label">Timezone</th>
              <th className="t-label">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {people.data && rows.length === 0 ? <tr><td colSpan={6} className="t-small muted">Nobody matches this filter.</td></tr> : null}
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
      <p className="t-small muted" style={{ margin: 0 }}>Roles: Admins manage the workspace. Managers see reports and manage their own standups without Workspace-admin rights. Members get the personal console.</p>
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
