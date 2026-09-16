import { useState } from 'react';
import { SectionCard, SettingsRow } from '../../components/settings-row';
import { fromMutation, VerifyStatus } from '../../components/verify-status';
import { usePatchSettings, useSettings, useVerifyMutation } from '../../lib/settings';
import { fieldError, SettingsHeader } from './layout';

export function SignInSettings() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const verifySaml = useVerifyMutation('saml');
  const [google, setGoogle] = useState({ clientId: '', clientSecret: '' });
  const [saml, setSaml] = useState({ entityId: '', ssoUrl: '', cert: '', adminAttribute: '', adminGroup: '' });
  const [editing, setEditing] = useState<'google' | 'saml' | null>(null);
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
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return (
    <>
      <SettingsHeader title="Sign-in & SSO" lede="Workspace admins get this console; everyone else gets their own page. Keep at least one method working." />
      {error ? <div className="alert" role="alert">{error}</div> : null}
      <SectionCard title="Google sign-in" hint="One OAuth client in the same Cloud project. Chat identity and web identity are the same user." action={<span className={`badge ${s.signIn.google.on ? 'badge-success' : ''}`}>{s.signIn.google.on ? 'On' : 'Off'}</span>}>
        <SettingsRow label="OAuth client" hint={`Authorised redirect URI: ${origin}/auth/callback`}>
          {editing === 'google' ? (
            <>
              <input className="input" aria-label="OAuth client ID" value={google.clientId} onChange={(e) => setGoogle({ ...google, clientId: e.target.value })} placeholder="….apps.googleusercontent.com" />
              <input className="input" aria-label="OAuth client secret" type="password" value={google.clientSecret} onChange={(e) => setGoogle({ ...google, clientSecret: e.target.value })} placeholder={s.signIn.google.clientSecret.set ? 'Leave empty to keep the stored secret' : ''} />
              <button type="button" className="btn btn-primary" style={{ height: 28 }} disabled={!google.clientId.trim() || patch.isPending} onClick={() => void save({ oauthClientId: google.clientId.trim(), ...(google.clientSecret.trim() ? { oauthClientSecret: google.clientSecret.trim() } : {}) }).then((ok) => ok && setEditing(null))}>Save</button>
              <button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={() => setEditing(null)}>Cancel</button>
            </>
          ) : (
            <>
              <span className="t-mono" style={{ overflowWrap: 'anywhere' }}>{s.signIn.google.clientId || 'Not configured'}</span>
              <button type="button" className="btn" style={{ height: 28 }} onClick={() => { setGoogle({ clientId: s.signIn.google.clientId, clientSecret: '' }); setEditing('google'); }}>{s.signIn.google.on ? 'Change' : 'Set up'}</button>
              {s.signIn.google.on ? <button type="button" className="btn btn-ghost btn-danger" style={{ height: 28 }} onClick={() => void save({ oauthClientId: '', oauthClientSecret: null })}>Remove</button> : null}
            </>
          )}
        </SettingsRow>
      </SectionCard>
      <SectionCard title="SAML single sign-on" hint="Okta, Entra, OneLogin or any SAML 2.0 IdP. SCIM provisioning included." action={<span className={`badge ${s.signIn.saml.on ? 'badge-success' : ''}`}>{s.signIn.saml.on ? 'On' : 'Off'}</span>}>
        <SettingsRow label="Identity provider" hint={`SP metadata: ${origin}/auth/saml/metadata`}>
          {editing === 'saml' ? (
            <>
              <input className="input" aria-label="IdP entity ID" value={saml.entityId} onChange={(e) => setSaml({ ...saml, entityId: e.target.value })} placeholder="IdP entity ID" />
              <input className="input" aria-label="IdP SSO URL" value={saml.ssoUrl} onChange={(e) => setSaml({ ...saml, ssoUrl: e.target.value })} placeholder="https://…/sso" />
              <textarea className="paste" aria-label="IdP certificate (PEM)" value={saml.cert} onChange={(e) => setSaml({ ...saml, cert: e.target.value })} placeholder={s.signIn.saml.cert.set ? 'Leave empty to keep the stored certificate' : 'PEM certificate'} style={{ flexBasis: '100%', minHeight: 80 }} />
              <input className="input" aria-label="Admin attribute" value={saml.adminAttribute} onChange={(e) => setSaml({ ...saml, adminAttribute: e.target.value })} placeholder="Admin attribute (e.g. groups)" />
              <input className="input" aria-label="Admin group" value={saml.adminGroup} onChange={(e) => setSaml({ ...saml, adminGroup: e.target.value })} placeholder="Admin group value" />
              <button type="button" className="btn btn-primary" style={{ height: 28 }} disabled={!saml.entityId.trim() || !saml.ssoUrl.trim() || patch.isPending} onClick={() => void save({ samlIdpEntityId: saml.entityId.trim(), samlIdpSsoUrl: saml.ssoUrl.trim(), ...(saml.cert.trim() ? { samlIdpCert: saml.cert.trim() } : {}), samlAdminAttribute: saml.adminAttribute.trim(), samlAdminGroup: saml.adminGroup.trim() }).then((ok) => { if (ok) { setEditing(null); verifySaml.mutate(undefined); } })}>Save and check</button>
              <button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={() => setEditing(null)}>Cancel</button>
            </>
          ) : (
            <>
              <span className="t-mono" style={{ overflowWrap: 'anywhere' }}>{s.signIn.saml.entityId || 'Not configured'}</span>
              <button type="button" className="btn" style={{ height: 28 }} onClick={() => { setSaml({ entityId: s.signIn.saml.entityId, ssoUrl: s.signIn.saml.ssoUrl, cert: '', adminAttribute: s.signIn.saml.adminAttribute, adminGroup: s.signIn.saml.adminGroup }); setEditing('saml'); }}>{s.signIn.saml.on ? 'Change' : 'Set up'}</button>
              {s.signIn.saml.on ? <button type="button" className="btn btn-ghost" style={{ height: 28 }} disabled={verifySaml.isPending} onClick={() => verifySaml.mutate(undefined)}>Check IdP</button> : null}
            </>
          )}
          {verifySaml.data || verifySaml.isPending || verifySaml.isError ? <div style={{ flexBasis: '100%' }}><VerifyStatus state={fromMutation(verifySaml)} /></div> : null}
        </SettingsRow>
      </SectionCard>
      <SectionCard title="Setup token">
        <SettingsRow label="Accept DASHBOARD_TOKEN for sign-in" hint="Switch off once Google or SAML works. Recovery is documented in the handbook if you lock yourself out.">
          <label className="row t-small">
            <input type="checkbox" checked={s.signIn.tokenSignIn} onChange={(e) => void save({ tokenSignIn: e.target.checked })} /> {s.signIn.tokenSignIn ? 'On' : 'Off'}
          </label>
        </SettingsRow>
      </SectionCard>
    </>
  );
}
