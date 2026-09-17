import { useState } from 'react';
import { CopyRow } from '../../components/copy-row';
import { SectionCard, SettingsRow } from '../../components/settings-row';
import { useMachineToken, useSettings } from '../../lib/settings';
import { fieldError, SettingsHeader } from './layout';

const TOKENS = [
  { name: 'tick', label: 'Tick token', hint: 'External cron for scale-to-zero hosts: POST /tick with this bearer. Open until one exists.' },
  { name: 'export', label: 'Export token', hint: 'GET /export?standupId=N&days=D for scripts and BI tools. 404 until one exists.' },
  { name: 'scim', label: 'SCIM token', hint: 'Bearer for /scim/v2 provisioning from Okta or Entra. 404 until one exists.' },
] as const;

export function TokenSettings() {
  const settings = useSettings();
  const machine = useMachineToken();
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = settings.data;
  if (settings.isError) return <div className="alert">Could not load settings: {settings.error.message}</div>;
  if (!s) return <p className="muted">Loading…</p>;
  const act = async (name: (typeof TOKENS)[number]['name'], action: 'generate' | 'clear') => {
    try {
      setError(null);
      const r = await machine.mutateAsync({ name, action });
      setMinted(r ? { name, token: r.token } : null);
    } catch (err) {
      setError(fieldError(err));
    }
  };
  return (
    <>
      <SettingsHeader title="API & tokens" lede="Machine access. Each token is shown once when generated; the JSON API itself uses your session or the operator token." />
      {error ? <div className="alert" role="alert">{error}</div> : null}
      <SectionCard title="Machine tokens">
        {TOKENS.map((t) => (
          <SettingsRow key={t.name} label={t.label} hint={t.hint}>
            <span className={`badge ${s.tokens[t.name].set ? 'badge-success' : ''}`}>{s.tokens[t.name].set ? 'Set' : 'Not set'}</span>
            <button type="button" className="btn" style={{ height: 28 }} disabled={machine.isPending} onClick={() => void act(t.name, 'generate')}>{s.tokens[t.name].set ? 'Rotate' : 'Generate'}</button>
            {s.tokens[t.name].set ? <button type="button" className="btn btn-ghost btn-danger" style={{ height: 28 }} disabled={machine.isPending} onClick={() => void act(t.name, 'clear')}>Clear</button> : null}
            {minted?.name === t.name ? (
              <div className="secret" role="status" style={{ flexBasis: '100%' }}>
                <div className="t-medium">Copy it now — it will not be shown again.</div>
                <CopyRow label={t.label} value={minted.token} />
              </div>
            ) : null}
          </SettingsRow>
        ))}
      </SectionCard>
      <SectionCard title="JSON API">
        <SettingsRow label="Base URL" hint="Same rules as this app: session cookie plus the X-Requested-With header, or a bearer token.">
          <span className="t-mono">{typeof location !== 'undefined' ? location.origin : ''}/api/v1</span>
          <a className="btn btn-ghost" style={{ height: 28 }} href="https://asyncup-dev.github.io/docs/guide/api" target="_blank" rel="noreferrer">API reference ↗</a>
        </SettingsRow>
      </SectionCard>
    </>
  );
}
