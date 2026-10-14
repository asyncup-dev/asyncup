import { useNavigate, useSearch } from '@tanstack/react-router';
import { GrantForm, GrantTable } from '../../components/grants';
import { SectionCard } from '../../components/settings-row';
import { useMe } from '../../lib/auth';
import { useGrants, useRoleAudit, useRoles } from '../../lib/roles';
import { useStandups } from '../../lib/standups';
import { SettingsHeader } from './layout';

export function AccessSettings() {
  const me = useMe().data;
  const { role } = useSearch({ strict: false }) as { role?: string };
  const navigate = useNavigate();
  const roles = useRoles();
  const grants = useGrants();
  const standups = useStandups();
  const audit = useRoleAudit();
  if (roles.isError) return <div className="alert">Could not load roles: {roles.error.message}</div>;
  if (grants.isError) return <div className="alert">Could not load who holds what: {grants.error.message}</div>;
  if (!me || !roles.data || !grants.data) return <p className="muted">Loading…</p>;
  const shown = role ? grants.data.filter((g) => g.role.id === role) : grants.data;
  return (
    <>
      <SettingsHeader
        title="Access"
        lede="Who holds which role, and where. Everyone on a standup is a Member of it and its managers are Managers, so neither is listed here. Google Workspace and SAML admins are admins through sign-in."
      />
      <SectionCard title="Grant a role" hint="By email: the person gets it when they sign in with that address, or in Chat once AsyncUp knows their email.">
        <GrantForm me={me} roles={roles.data} standups={(standups.data ?? []).map((s) => ({ id: s.id, name: s.name }))} />
      </SectionCard>
      <SectionCard
        title={`Granted · ${shown.length}`}
        action={
          <select className="input" aria-label="Filter by role" style={{ width: 'auto' }} value={role ?? ''} onChange={(e) => void navigate({ to: '/settings/access', search: e.target.value ? { role: e.target.value } : {} })}>
            <option value="">Every role</option>
            {roles.data.filter((r) => r.grantable).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        }
      >
        <GrantTable grants={shown} empty={role ? 'Nobody holds this role through a grant.' : 'No roles granted yet.'} />
      </SectionCard>
      <SectionCard title="History" hint="Every change to roles and grants, newest first.">
        {audit.isError ? <div className="settings-row"><span className="alert">Could not load the history: {audit.error.message}</span></div> : null}
        {audit.data?.length === 0 ? <p className="t-small muted" style={{ padding: 'var(--space-3) var(--space-5)', margin: 0 }}>No changes yet.</p> : null}
        {audit.data?.map((e) => (
          <div key={e.id} className="settings-row">
            <div className="t-caption">{new Date(e.at).toLocaleString()} · {e.actor}</div>
            <div className="t-small">{e.summary}</div>
          </div>
        ))}
      </SectionCard>
    </>
  );
}
