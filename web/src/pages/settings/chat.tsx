import { useState } from 'react';
import { SectionCard, SettingsRow } from '../../components/settings-row';
import { fromMutation, VerifyStatus } from '../../components/verify-status';
import { projectNumberOf } from '../../lib/setup';
import { usePatchSettings, useSettings, useVerifyMutation } from '../../lib/settings';
import { fieldError, SettingsHeader } from './layout';

export function ChatSettings() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const verifyProject = useVerifyMutation('project');
  const verifySa = useVerifyMutation('service-account');
  const verifyEvent = useVerifyMutation('chat-event');
  const verifyDm = useVerifyMutation('dm');
  const [number, setNumber] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [adminEmail, setAdminEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = settings.data;
  if (settings.isError) return <div className="alert">Could not load settings: {settings.error.message}</div>;
  if (!s) return <p className="muted">Loading…</p>;
  const save = async (body: Record<string, unknown>) => {
    try {
      setError(null);
      await patch.mutateAsync(body);
      return true;
    } catch (err) {
      setError(fieldError(err));
      return false;
    }
  };
  const stored = projectNumberOf(s.chat.audience);
  const current = number ?? stored;
  const others = s.chat.audience.split(/[\s,]+/).filter((a) => a && !/^\d+$/.test(a));
  const dwdOn = !!s.workspace.workspaceAdminEmail;
  const email = adminEmail ?? s.workspace.workspaceAdminEmail;
  return (
    <>
      <SettingsHeader title="Google Chat" lede="The connection that makes everything work. Each row saves on its own." />
      {error ? <div className="alert" role="alert">{error}</div> : null}
      <SectionCard title="Connection">
        <SettingsRow label="Project number" hint="GCP project that owns the Chat app. Used to verify incoming events.">
          <input className="input" aria-label="Project number" inputMode="numeric" value={current} onChange={(e) => setNumber(e.target.value)} />
          <span className={`badge ${stored ? 'badge-success' : 'badge-warning'}`}>{stored ? 'Set' : 'Missing'}</span>
          <button type="button" className="btn" style={{ height: 28 }} disabled={current === stored || patch.isPending} onClick={() => void save({ chatAudience: [current.trim(), ...others].join(' ') }).then((ok) => ok && verifyProject.mutate(undefined))}>Save</button>
          <button type="button" className="btn btn-ghost" style={{ height: 28 }} disabled={!stored || verifyProject.isPending} onClick={() => verifyProject.mutate(undefined)}>Verify</button>
          {verifyProject.data || verifyProject.isPending || verifyProject.isError ? <div style={{ flexBasis: '100%' }}><VerifyStatus state={fromMutation(verifyProject)} /></div> : null}
        </SettingsRow>
        <SettingsRow label="Service account" hint="Identity AsyncUp sends messages as. Key is encrypted at rest.">
          {s.chat.serviceAccount.set && !replacing ? (
            <>
              <span className="t-mono" style={{ overflowWrap: 'anywhere' }}>{s.chat.serviceAccount.email ?? 'stored'}</span>
              <span className="badge badge-success">Key stored</span>
              <button type="button" className="btn" style={{ height: 28 }} onClick={() => setReplacing(true)}>Replace key</button>
              <button type="button" className="btn btn-ghost" style={{ height: 28 }} disabled={verifySa.isPending} onClick={() => verifySa.mutate(undefined)}>Verify</button>
            </>
          ) : (
            <>
              <textarea className="paste" aria-label="Service-account key (JSON)" value={key} onChange={(e) => setKey(e.target.value)} placeholder='{ "type": "service_account", … }' spellCheck={false} style={{ flexBasis: '100%' }} />
              <button type="button" className="btn btn-primary" style={{ height: 28 }} disabled={!key.trim() || patch.isPending} onClick={() => void save({ serviceAccountJson: key }).then((ok) => { if (ok) { setKey(''); setReplacing(false); verifySa.mutate(undefined); } })}>Save key</button>
              {s.chat.serviceAccount.set ? <button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={() => setReplacing(false)}>Cancel</button> : null}
            </>
          )}
          {verifySa.data || verifySa.isPending || verifySa.isError ? <div style={{ flexBasis: '100%' }}><VerifyStatus state={fromMutation(verifySa)} /></div> : null}
        </SettingsRow>
        <SettingsRow label="Connection test" hint="Confirm events arrive from Google, then send yourself a test DM.">
          <button type="button" className="btn" style={{ height: 28 }} disabled={verifyEvent.isPending} onClick={() => verifyEvent.mutate(undefined)}>Check events</button>
          <button type="button" className="btn" style={{ height: 28 }} disabled={verifyDm.isPending} onClick={() => verifyDm.mutate(undefined)}>Send me a test DM</button>
          {verifyEvent.data || verifyEvent.isPending || verifyEvent.isError ? <div style={{ flexBasis: '100%' }}><VerifyStatus state={fromMutation(verifyEvent)} /></div> : null}
          {verifyDm.data || verifyDm.isPending || verifyDm.isError ? <div style={{ flexBasis: '100%' }}><VerifyStatus state={fromMutation(verifyDm)} /></div> : null}
        </SettingsRow>
        <SettingsRow label="Directory & Calendar access" hint="Resolves emails, recognises admins, marks people away on OOO days. Needs domain-wide delegation.">
          <label className="row t-small">
            <input type="checkbox" checked={dwdOn} onChange={(e) => (e.target.checked ? setAdminEmail(email || '') : void save({ workspaceAdminEmail: '' }))} /> {dwdOn ? `On · acting as ${s.workspace.workspaceAdminEmail}` : 'Off'}
          </label>
          {adminEmail !== null || (!dwdOn && adminEmail === '') ? (
            <>
              <input className="input" type="email" aria-label="Workspace admin to act as" value={email} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@yourdomain.com" />
              <button type="button" className="btn" style={{ height: 28 }} disabled={!email.trim() || patch.isPending} onClick={() => void save({ workspaceAdminEmail: email.trim() }).then((ok) => ok && setAdminEmail(null))}>Save</button>
            </>
          ) : null}
          {s.chat.serviceAccount.clientId ? <div className="t-caption" style={{ flexBasis: '100%' }}>Delegation client ID: <span className="t-mono">{s.chat.serviceAccount.clientId}</span></div> : null}
        </SettingsRow>
      </SectionCard>
    </>
  );
}
