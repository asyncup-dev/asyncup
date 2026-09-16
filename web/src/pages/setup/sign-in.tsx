import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { fromMutation, VerifyStatus } from '../../components/verify-status';
import { useSaveSettings, useSetupProgress, useVerify } from '../../lib/setup';
import { StepActions, StepPage } from './layout';

export function SignInSetupPage() {
  const progress = useSetupProgress();
  const save = useSaveSettings();
  const verifySaml = useVerify('saml');
  const [open, setOpen] = useState<'google' | 'saml' | null>(null);
  const [google, setGoogle] = useState({ clientId: '', clientSecret: '' });
  const [saml, setSaml] = useState({ entityId: '', ssoUrl: '', cert: '' });
  const signIn = progress.data?.settings.signIn;

  const saveGoogle = async () => {
    await save.mutateAsync({ oauthClientId: google.clientId.trim(), oauthClientSecret: google.clientSecret.trim() });
    setGoogle({ clientId: '', clientSecret: '' });
    setOpen(null);
  };
  const saveSaml = async () => {
    await save.mutateAsync({ samlIdpEntityId: saml.entityId.trim(), samlIdpSsoUrl: saml.ssoUrl.trim(), samlIdpCert: saml.cert.trim() });
    setSaml({ entityId: '', ssoUrl: '', cert: '' });
    await verifySaml.mutateAsync();
    setOpen(null);
  };

  return (
    <StepPage id="sign-in" kicker="Step 4 of 5 · optional" title="How will your team sign in?" lede="Workspace admins get this console. Everyone else gets their own page to see their standups, set a timezone and switch on vacation mode. You can keep using the setup token for now and add this later.">
      <div className="grid-2">
        <div className="card section">
          <div className="row">
            <h2 className="t-h3">Google sign-in</h2>
            <span className="badge badge-info">Recommended</span>
            {signIn?.google.on ? <span className="badge badge-success">Configured</span> : null}
          </div>
          <p className="t-small secondary" style={{ margin: 0 }}>One OAuth client in the same Cloud project. Chat identity and web identity are the same user — no account linking.</p>
          <ul className="t-small secondary" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Admins recognised via Workspace Directory</li>
            <li>Works for every member of the domain</li>
          </ul>
          {open === 'google' ? (
            <div className="field">
              <label htmlFor="oauth-id">OAuth client ID</label>
              <input id="oauth-id" className="input" value={google.clientId} onChange={(e) => setGoogle({ ...google, clientId: e.target.value })} placeholder="….apps.googleusercontent.com" />
              <label htmlFor="oauth-secret">OAuth client secret</label>
              <input id="oauth-secret" className="input" type="password" value={google.clientSecret} onChange={(e) => setGoogle({ ...google, clientSecret: e.target.value })} />
              <div className="t-caption">Authorised redirect URI: {typeof location !== 'undefined' ? location.origin : ''}/auth/callback</div>
              <div className="row">
                <button type="button" className="btn btn-primary" disabled={!google.clientId.trim() || !google.clientSecret.trim() || save.isPending} onClick={() => void saveGoogle()}>Save</button>
                <button type="button" className="btn btn-ghost" onClick={() => setOpen(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setOpen('google')}>{signIn?.google.on ? 'Change Google sign-in' : 'Set up Google sign-in'}</button>
          )}
        </div>
        <div className="card section">
          <div className="row">
            <h2 className="t-h3">SAML single sign-on</h2>
            {signIn?.saml.on ? <span className="badge badge-success">Configured</span> : null}
          </div>
          <p className="t-small secondary" style={{ margin: 0 }}>Okta, Entra, OneLogin or any SAML 2.0 IdP. SCIM provisioning included — deactivate in the IdP, removed from every roster.</p>
          <ul className="t-small secondary" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Admin role from an IdP group attribute</li>
            <li>Identities link to Chat by email</li>
          </ul>
          {open === 'saml' ? (
            <div className="field">
              <label htmlFor="saml-entity">IdP entity ID</label>
              <input id="saml-entity" className="input" value={saml.entityId} onChange={(e) => setSaml({ ...saml, entityId: e.target.value })} />
              <label htmlFor="saml-sso">IdP SSO URL</label>
              <input id="saml-sso" className="input" value={saml.ssoUrl} onChange={(e) => setSaml({ ...saml, ssoUrl: e.target.value })} placeholder="https://…" />
              <label htmlFor="saml-cert">IdP certificate (PEM)</label>
              <textarea id="saml-cert" className="paste" value={saml.cert} onChange={(e) => setSaml({ ...saml, cert: e.target.value })} />
              <div className="t-caption">SP metadata: {typeof location !== 'undefined' ? location.origin : ''}/auth/saml/metadata</div>
              <div className="row">
                <button type="button" className="btn btn-primary" disabled={!saml.entityId.trim() || !saml.ssoUrl.trim() || !saml.cert.trim() || save.isPending} onClick={() => void saveSaml()}>Save and check</button>
                <button type="button" className="btn btn-ghost" onClick={() => setOpen(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setOpen('saml')}>{signIn?.saml.on ? 'Change SAML' : 'Set up SAML'}</button>
          )}
          {verifySaml.data || verifySaml.isPending || verifySaml.isError ? <VerifyStatus state={fromMutation(verifySaml)} /> : null}
        </div>
      </div>
      {save.isError ? <div className="alert" role="alert">{save.error.message}</div> : null}
      <div className="verify verify-idle">You are signed in with the setup token right now. Once a method above works, you can switch the token off in Settings → Sign-in.</div>
      <StepActions back="/setup/chat-app">
        <Link to="/setup/template" className="btn btn-ghost">Skip for now</Link>
        <Link to="/setup/template" className="btn btn-primary">Continue</Link>
      </StepActions>
    </StepPage>
  );
}
