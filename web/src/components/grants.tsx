import { useState, type FormEvent } from 'react';
import { heldAt } from '../lib/access';
import type { Me } from '../lib/api';
import { shortDate } from '../lib/format';
import { grantableAt, grantee, useGrant, useRevoke, type Grant, type Role } from '../lib/roles';
import { ConfirmDialog } from './confirm-dialog';

/**
 * Give a role by email. With `standups`, the person picks the whole workspace
 * or one standup; with `standupId`, the grant is on that standup only.
 */
export function GrantForm({ me, roles, standups, standupId }: { me: Me; roles: Role[]; standups?: { id: number; name: string }[]; standupId?: number }) {
  const grant = useGrant();
  const [scope, setScope] = useState<number | null>(standupId ?? null);
  const options = grantableAt(roles, heldAt(me, scope), scope);
  const [form, setForm] = useState({ email: '', displayName: '', role: '' });
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const role = options.some((r) => r.id === form.role) ? form.role : options[0]?.id ?? '';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setError(null);
      setDone(null);
      const g = await grant.mutateAsync({ email: form.email.trim(), displayName: form.displayName.trim() || undefined, role, standupId: scope });
      setDone(`${g.role.name} granted to ${grantee(g)} ${g.standup ? `on ${g.standup.name}` : 'across the workspace'}.`);
      setForm({ email: '', displayName: '', role });
    } catch (err) {
      setError(err instanceof Error ? { message: err.message, field: (err as { field?: string }).field } : { message: 'That did not save.' });
    }
  };
  return (
    <form className="settings-row" style={{ gridTemplateColumns: '1fr' }} onSubmit={(e) => void submit(e)} aria-label="Grant a role">
      <div className="settings-control">
        <input className="input" type="email" required aria-label="Email" placeholder="name@example.com" style={{ width: 220 }} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input className="input" aria-label="Name (optional)" placeholder="Name (optional)" style={{ width: 160 }} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        <select className="input" aria-label="Role" style={{ width: 'auto' }} value={role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {options.length === 0 ? <option value="">No role you can grant here</option> : null}
          {options.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        {standups ? (
          <select className="input" aria-label="Where" style={{ width: 'auto' }} value={scope ?? ''} onChange={(e) => setScope(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Whole workspace</option>
            {standups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        ) : null}
        <button type="submit" className="btn btn-primary" style={{ height: 32 }} disabled={grant.isPending || !role || !form.email.trim()}>Grant</button>
      </div>
      {scope !== null && standups ? <div className="t-caption">Roles with workspace-wide permissions can only be granted across the workspace.</div> : null}
      {error ? <div className="alert" role="alert">{error.message}</div> : null}
      {done ? <div className="notice t-small" role="status">{done} It applies from their next page load or Chat message.</div> : null}
    </form>
  );
}

/** Grants with who gave them and when, each with a Revoke button. */
export function GrantTable({ grants, showScope = true, empty }: { grants: Grant[]; showScope?: boolean; empty: string }) {
  const revoke = useRevoke();
  const [confirm, setConfirm] = useState<Grant | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (grants.length === 0) return <p className="t-small muted" style={{ padding: 'var(--space-3) var(--space-5)', margin: 0 }}>{empty}</p>;
  return (
    <>
      {error ? <div className="alert" role="alert" style={{ margin: 'var(--space-3) var(--space-5)' }}>{error}</div> : null}
      <table className="table" aria-label="Granted roles">
        <thead>
          <tr>
            <th className="t-label">Person</th>
            <th className="t-label">Role</th>
            {showScope ? <th className="t-label">Where</th> : null}
            <th className="t-label">Granted</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {grants.map((g) => (
            <tr key={g.id}>
              <td data-label="Person">
                <div className="t-medium">{grantee(g)}</div>
                {grantee(g) !== g.email ? <div className="t-caption">{g.email}</div> : null}
              </td>
              <td data-label="Role"><span className="badge badge-info">{g.role.name}</span></td>
              {showScope ? <td data-label="Where" className="t-small">{g.standup?.name ?? 'Whole workspace'}</td> : null}
              <td data-label="Granted" className="t-small secondary">{shortDate(g.grantedAt.slice(0, 10))} by {g.grantedBy}</td>
              <td style={{ textAlign: 'right' }}>
                <button type="button" className="btn btn-ghost btn-danger" style={{ height: 28 }} disabled={revoke.isPending} onClick={() => setConfirm(g)}>Revoke</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {confirm ? (
        <ConfirmDialog
          title={`Revoke ${confirm.role.name} from ${grantee(confirm)}?`}
          body={`They lose what the role gives them ${confirm.standup ? `on ${confirm.standup.name}` : 'across the workspace'}. Anything they hold another way stays.`}
          confirmLabel="Revoke"
          danger
          onConfirm={async () => {
            try {
              setError(null);
              await revoke.mutateAsync(confirm.id);
            } catch (err) {
              setError(err instanceof Error ? err.message : 'That did not revoke.');
            }
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </>
  );
}
