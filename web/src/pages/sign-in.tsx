import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { LogoMark } from '../components/logo';
import { api, ApiError, setStoredToken, type Me } from '../lib/api';
import { useAuthMethods } from '../lib/auth';

export function SignInPage() {
  const methods = useAuthMethods();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitToken = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStoredToken(token.trim());
    try {
      const me = await api<Me>('/me');
      client.setQueryData(['me'], me);
      await navigate({ to: '/standups' });
    } catch (err) {
      setStoredToken(null);
      setError(err instanceof ApiError && err.status === 401 ? 'That token was not accepted.' : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const m = methods.data;
  const host = typeof location !== 'undefined' ? location.host : '';
  return (
    <div className="signin">
      <div className="panel card">
        <span className="logo"><LogoMark size={48} /></span>
        <h1 className="t-h2">Sign in to AsyncUp</h1>
        <div className="sub t-small secondary">{host}</div>
        {methods.isError ? <div className="alert">Could not load sign-in options. Is the server up?</div> : null}
        {m?.google ? <a className="btn btn-primary btn-block btn-lg" href="/auth/google">Continue with Google</a> : null}
        {m?.saml ? <a className="btn btn-block btn-lg" href="/auth/saml">Continue with SSO</a> : null}
        {m && (m.google || m.saml) && m.token ? <div className="divider t-small">or</div> : null}
        {m?.token ? (
          <form className="field" onSubmit={submitToken}>
            <label htmlFor="token">Operator token</label>
            <input id="token" className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />
            {error ? <div className="alert" role="alert">{error}</div> : null}
            <button type="submit" className="btn" disabled={busy || !token.trim()} style={{ justifySelf: 'center', minWidth: 140 }}>
              Sign in
            </button>
          </form>
        ) : null}
        {m && !m.google && !m.saml && !m.token ? <div className="alert">No sign-in method is enabled. Set DASHBOARD_TOKEN or configure Google or SAML sign-in.</div> : null}
        <p className="t-small muted" style={{ margin: 0, textAlign: 'center' }}>Admins land in the console. Everyone else sees their own standups.</p>
      </div>
    </div>
  );
}
