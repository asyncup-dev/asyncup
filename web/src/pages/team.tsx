import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog';
import { ScheduleDrawer } from '../components/schedule-drawer';
import { useAccess } from '../lib/access';
import { roleOf, useParticipantPatch, useParticipantRemove, usePeople, type PersonRow } from '../lib/people';
import { dateSpan, groupRequests, useDecide, useDecideEdit, useEditRequests, useRequests } from '../lib/schedule';

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
  const access = useAccess();
  const decides = access.canSomewhere('schedules.manage');
  const decidesEdits = access.canSomewhere('standups.configure');
  const requests = useRequests(decides);
  const edits = useEditRequests(decidesEdits);
  const decide = useDecide();
  const decideEdit = useDecideEdit();
  const groups = groupRequests(requests.data ?? []);
  const requestCount = groups.length + (edits.data?.length ?? 0);
  const requestsLoaded = (!decides || !!requests.data) && (!decidesEdits || !!edits.data);
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
        {(['everyone', 'managers', 'away', ...(decides || decidesEdits ? (['requests'] as const) : [])] as const).map((f) => (
          <button key={f} type="button" role="tab" className="chip-tab" aria-pressed={filter === f} aria-selected={filter === f} onClick={() => setFilter(f)}>
            {FILTER_LABEL[f]} · {f === 'requests' ? requestCount : (people.data ?? []).filter((p) => matches(p, f)).length}
          </button>
        ))}
      </div>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      {filter === 'requests' ? (
        <div className="card" style={{ padding: 0 }}>
          {requests.isError ? <div className="alert" style={{ margin: 16 }}>Could not load requests: {requests.error.message}</div> : null}
          {edits.isError ? <div className="alert" style={{ margin: 16 }}>Could not load edit requests: {edits.error.message}</div> : null}
          {requestsLoaded && requestCount === 0 ? <div className="t-small muted" style={{ padding: 16 }}>No requests waiting. Time-off requests appear here when a standup’s time-off policy needs a manager’s approval, and requests to edit answers when someone asks after the deadline.</div> : null}
          {(edits.data ?? []).map((r) => (
            <RequestRow
              key={`edit-${r.id}`}
              name={r.displayName}
              line={`Edit answers · ${r.standupName} · ${dateSpan([r.date])}`}
              caption={`${r.reason ? `“${r.reason}” · ` : ''}answered at ${clock(r.answeredAt, r.until)} · lapses at ${r.until} if unanswered`}
              declining={declining?.key === `edit-${r.id}` ? declining.note : null}
              busy={decideEdit.isPending}
              onToggleDecline={() => setDeclining(declining?.key === `edit-${r.id}` ? null : { key: `edit-${r.id}`, note: '' })}
              onNote={(note) => setDeclining({ key: `edit-${r.id}`, note })}
              onDecline={(note) => void act(async () => { await decideEdit.mutateAsync({ id: r.id, approve: false, note }); setDeclining(null); })}
              onApprove={() => void act(() => decideEdit.mutateAsync({ id: r.id, approve: true }))}
            />
          ))}
          {groups.map((g) => (
            <RequestRow
              key={g.key}
              name={g.person}
              line={`${dateSpan(g.dates)} · ${g.dates.length} day${g.dates.length === 1 ? '' : 's'} ${g.working ? 'working' : 'off'}`}
              caption={`${g.reason ? `“${g.reason}” · ` : ''}requested via ${g.channel} · lapses at the run’s deadline if unanswered`}
              declining={declining?.key === g.key ? declining.note : null}
              busy={decide.isPending}
              onToggleDecline={() => setDeclining(declining?.key === g.key ? null : { key: g.key, note: '' })}
              onNote={(note) => setDeclining({ key: g.key, note })}
              onDecline={(note) => void act(async () => { await decide.mutateAsync({ ids: g.ids, approve: false, note }); setDeclining(null); })}
              onApprove={() => void act(() => decide.mutateAsync({ ids: g.ids, approve: true }))}
            />
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
            {rows.map((p) => {
              const managed = p.standups.filter((s) => access.can('people.manage', s.id));
              const schedules = p.standups.some((s) => access.can('schedules.manage', s.id));
              return (
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
                    {managed.length || schedules ? (
                      <div className="menu" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button type="button" className="icon-btn" aria-label={`Actions for ${p.displayName}`} aria-expanded={menuFor === p.userName} onClick={() => setMenuFor(menuFor === p.userName ? null : p.userName)}>⋯</button>
                        {menuFor === p.userName ? (
                          <div className="menu-list" role="menu">
                            {managed.map((s) => (
                              <div key={s.id} style={{ display: 'contents' }}>
                                <div className="t-label" style={{ padding: '6px 12px 2px' }}>{s.name}</div>
                                <button type="button" role="menuitem" onClick={() => void act(() => patch.mutateAsync({ standupId: s.id, userName: p.userName, patch: { mandatory: !s.mandatory } }))}>{s.mandatory ? 'Make optional' : 'Make mandatory'}</button>
                                <button type="button" role="menuitem" onClick={() => void act(() => patch.mutateAsync({ standupId: s.id, userName: p.userName, patch: { admin: !s.admin } }))}>{s.admin ? 'Remove as manager' : 'Make manager'}</button>
                                <button type="button" role="menuitem" className="danger" onClick={() => { setMenuFor(null); setConfirm({ person: p, standup: s }); }}>Remove from {s.name}</button>
                              </div>
                            ))}
                            <div className="t-label" style={{ padding: '6px 12px 2px' }}>Everywhere</div>
                            {schedules ? <button type="button" role="menuitem" onClick={() => { setMenuFor(null); setScheduleFor(p); }}>Edit schedule…</button> : null}
                            {managed.length ? <button type="button" role="menuitem" onClick={() => void act(async () => { for (const s of managed) await patch.mutateAsync({ standupId: s.id, userName: p.userName, patch: { onVacation: !p.onVacation } }); })}>{p.onVacation ? 'Mark as back' : 'Mark as away'}</button> : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
      <p className="t-small muted" style={{ margin: 0 }}>Roles: Admins manage the workspace. Managers run their own standups. Members get the personal console. Custom roles and who holds them are under Settings › Roles and Access.</p>
      {scheduleFor ? <ScheduleDrawer target={{ userName: scheduleFor.userName }} title="Edit schedule" onClose={() => setScheduleFor(null)} /> : null}
      {confirm ? (
        <ConfirmDialog
          title={`Remove ${confirm.person.displayName} from ${confirm.standup.name}?`}
          body="They come off today’s run too, unless they have already answered. Their past answers stay in the history."
          confirmLabel="Remove"
          danger
          onConfirm={() => act(() => remove.mutateAsync({ standupId: confirm.standup.id, userName: confirm.person.userName })).then(() => setConfirm(null))}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </>
  );
}

/** "09:12" in the standup's zone, which `until` ("23:59 Europe/London") names. */
function clock(iso: string, until: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: until.split(' ')[1] }).format(new Date(iso));
}

/** One request waiting for a decision; Decline… opens a note sent to the person. */
function RequestRow(props: {
  name: string;
  line: string;
  caption: string;
  declining: string | null;
  busy: boolean;
  onToggleDecline: () => void;
  onNote: (note: string) => void;
  onDecline: (note: string | undefined) => void;
  onApprove: () => void;
}) {
  return (
    <div className="request">
      <span className="avatar avatar-sm" aria-hidden="true">{props.name[0]}</span>
      {/* A basis lets the buttons wrap under the text on a phone instead of squeezing it. */}
      <span className="grow" style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div className="t-strong">{props.name}</div>
        <div>{props.line}</div>
        <div className="t-caption">{props.caption}</div>
        {props.declining !== null ? (
          <div className="row" style={{ marginTop: 8 }}>
            <input className="input" aria-label="Reason for declining" placeholder="Why not? (sent to the person)" value={props.declining} onChange={(e) => props.onNote(e.target.value)} />
            <button type="button" className="btn btn-danger" style={{ height: 32 }} disabled={props.busy} onClick={() => props.onDecline(props.declining!.trim() || undefined)}>Send decline</button>
          </div>
        ) : null}
      </span>
      <button type="button" className="btn btn-ghost" disabled={props.busy} onClick={props.onToggleDecline}>Decline…</button>
      <button type="button" className="btn btn-primary" disabled={props.busy} onClick={props.onApprove}>Approve</button>
    </div>
  );
}
