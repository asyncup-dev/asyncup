import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { SectionCard } from '../../components/settings-row';
import type { Permission } from '../../lib/access';
import { useMe } from '../../lib/auth';
import { useDeleteRole, usePermissionCatalogue, useRoles, useSaveRole, type PermissionInfo, type Role, type RoleDraft } from '../../lib/roles';
import { fieldError, SettingsHeader } from './layout';

/** Who holds a role, in words: Member and Manager also come from the standups themselves. */
export function holders(r: Role): string {
  const grants = `${r.grants} ${r.grants === 1 ? 'grant' : 'grants'}`;
  if (r.id === 'member') return 'Everyone on a standup';
  if (r.id === 'manager') return `Each standup’s managers · ${grants}`;
  return grants;
}

export function RoleSettings() {
  const me = useMe().data;
  const roles = useRoles();
  const catalogue = usePermissionCatalogue();
  const remove = useDeleteRole();
  const [editing, setEditing] = useState<{ id: string | null; draft: RoleDraft } | null>(null);
  const [confirm, setConfirm] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (roles.isError) return <div className="alert">Could not load roles: {roles.error.message}</div>;
  if (catalogue.isError) return <div className="alert">Could not load permissions: {catalogue.error.message}</div>;
  if (!roles.data || !catalogue.data || !me) return <p className="muted">Loading…</p>;
  const label = new Map(catalogue.data.map((p) => [p.id, p.label]));
  const all = catalogue.data.length;
  const open = (id: string | null, draft: RoleDraft) => {
    setError(null);
    setEditing({ id, draft });
  };
  return (
    <>
      <SettingsHeader title="Roles" lede="A role is a set of permissions. Built-in roles can’t be changed: copy one to start a custom role. Grant roles under Access, or on a standup’s Settings." />
      {error ? <div className="alert" role="alert">{error}</div> : null}
      {editing ? (
        <RoleEditor
          key={editing.id ?? 'new'}
          id={editing.id}
          initial={editing.draft}
          catalogue={catalogue.data}
          held={new Set(me.permissions.workspace)}
          onDone={() => setEditing(null)}
        />
      ) : null}
      <SectionCard
        title="Roles"
        hint="Admins hold every permission. Member is what everyone on a standup gets; Manager is what each standup’s managers get."
        action={<button type="button" className="btn btn-primary" style={{ height: 28 }} onClick={() => open(null, { name: '', description: '', permissions: [] })}>New role</button>}
      >
        <table className="table" aria-label="Roles">
          <thead>
            <tr>
              <th className="t-label">Role</th>
              <th className="t-label">Permissions</th>
              <th className="t-label">Held by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {roles.data.map((r) => (
              <tr key={r.id}>
                <td data-label="Role">
                  <div className="t-medium">
                    {r.name}
                    {r.builtIn ? <span className="badge" style={{ marginLeft: 6 }}>Built-in</span> : null}
                    {r.workspaceOnly ? <span className="badge badge-warning" style={{ marginLeft: 6 }}>Workspace only</span> : null}
                  </div>
                  {r.description ? <div className="t-caption">{r.description}</div> : null}
                </td>
                <td data-label="Permissions" className="t-small">
                  {r.permissions.length === all ? 'Everything' : `${r.permissions.length} of ${all}`}
                  <div className="t-caption">{r.permissions.length === all ? '' : r.permissions.map((p) => label.get(p) ?? p).join(' · ')}</div>
                </td>
                <td data-label="Held by" className="t-small">
                  {r.grantable && r.grants > 0 ? <Link to="/settings/access" search={{ role: r.id }}>{holders(r)}</Link> : holders(r)}
                </td>
                <td>
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-ghost" style={{ height: 28 }} aria-label={`Copy ${r.name}`} onClick={() => open(null, { name: `${r.name} (copy)`.slice(0, 40), description: r.description, permissions: r.permissions })}>Copy</button>
                    {r.builtIn ? null : (
                      <>
                        <button type="button" className="btn" style={{ height: 28 }} aria-label={`Edit ${r.name}`} onClick={() => open(r.id, { name: r.name, description: r.description, permissions: r.permissions })}>Edit</button>
                        <button type="button" className="btn btn-ghost btn-danger" style={{ height: 28 }} aria-label={`Delete ${r.name}`} onClick={() => setConfirm(r)}>Delete</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
      {confirm ? (
        <ConfirmDialog
          title={`Delete ${confirm.name}?`}
          body="The role goes for good. A role someone still holds can’t be deleted: revoke it first."
          confirmLabel="Delete"
          danger
          onConfirm={async () => {
            try {
              setError(null);
              await remove.mutateAsync(confirm.id);
            } catch (err) {
              setError(fieldError(err));
            }
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </>
  );
}

/** Name, description and a permission checklist. Only permissions the editor holds can be ticked. */
function RoleEditor({ id, initial, catalogue, held, onDone }: { id: string | null; initial: RoleDraft; catalogue: PermissionInfo[]; held: ReadonlySet<Permission>; onDone: () => void }) {
  const save = useSaveRole();
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const chosen = new Set(draft.permissions);
  // The server adds "See standups" whenever another standup permission is picked; show that up front.
  const needsView = catalogue.some((p) => !p.workspaceOnly && p.id !== 'standups.view' && chosen.has(p.id));
  const effective = needsView ? new Set([...chosen, 'standups.view' as Permission]) : chosen;
  const toggle = (p: Permission) => setDraft({ ...draft, permissions: chosen.has(p) ? draft.permissions.filter((x) => x !== p) : [...draft.permissions, p] });
  const submit = async () => {
    try {
      setError(null);
      await save.mutateAsync({ id, draft: { ...draft, name: draft.name.trim(), permissions: catalogue.map((p) => p.id).filter((p) => effective.has(p)) } });
      onDone();
    } catch (err) {
      setError(fieldError(err));
    }
  };
  const group = (title: string, items: PermissionInfo[]) => (
    <div>
      <div className="t-label" style={{ padding: 'var(--space-3) var(--space-5) 0' }}>{title}</div>
      <div className="checklist">
        {items.map((p) => {
          const implied = p.id === 'standups.view' && needsView;
          // A permission you lack can still be unticked, say on a copy of Admin.
          const missing = !held.has(p.id);
          const locked = implied || (missing && !chosen.has(p.id));
          return (
            <label key={p.id} style={{ padding: 'var(--space-3) var(--space-5)', cursor: locked ? 'default' : 'pointer' }}>
              <input type="checkbox" checked={effective.has(p.id)} disabled={locked} onChange={() => toggle(p.id)} />
              <span>
                <span className="t-medium">{p.label}</span>
                <div className="t-caption">
                  {p.description}
                  {implied ? ' · Needed by the others you picked.' : missing ? ' · You don’t hold this, so you can’t give it.' : ''}
                </div>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
  return (
    <SectionCard
      title={id === null ? 'New role' : `Edit ${initial.name}`}
      hint="A role with any workspace-wide permission can only be granted across the workspace."
      action={
        <div className="row">
          <button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={onDone}>Cancel</button>
          <button type="button" className="btn btn-primary" style={{ height: 28 }} disabled={save.isPending || !draft.name.trim() || effective.size === 0} onClick={() => void submit()}>{id === null ? 'Create role' : 'Save role'}</button>
        </div>
      }
    >
      {error ? <div className="settings-row" style={{ gridTemplateColumns: '1fr' }}><div className="alert" role="alert">{error}</div></div> : null}
      <div className="settings-row">
        <label className="t-medium" htmlFor="role-name">Name</label>
        <input id="role-name" className="input" maxLength={40} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </div>
      <div className="settings-row">
        <label className="t-medium" htmlFor="role-description">Description</label>
        <input id="role-description" className="input" placeholder="What the role is for" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      </div>
      {group('On standups', catalogue.filter((p) => !p.workspaceOnly))}
      {group('Across the workspace only', catalogue.filter((p) => p.workspaceOnly))}
    </SectionCard>
  );
}
