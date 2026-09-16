import { useState } from 'react';
import { CopyRow } from '../../components/copy-row';
import { SectionCard, SettingsRow } from '../../components/settings-row';
import { fromMutation, VerifyStatus } from '../../components/verify-status';
import { useMe } from '../../lib/auth';
import { ago, clock } from '../../lib/format';
import { clientSnippet, useCreateMcpToken, useMcpActivity, useMcpTokens, usePatchSettings, useRevokeMcpToken, useSettings, useVerifyMutation } from '../../lib/settings';
import { copyText } from '../../lib/setup';
import { fieldError, SettingsHeader } from './layout';

const CLIENTS = [
  ['claude-desktop', 'Claude Desktop'],
  ['claude-code', 'Claude Code'],
  ['cursor', 'Cursor'],
  ['generic', 'Generic'],
] as const;

export function McpSettings() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const verify = useVerifyMutation('mcp');
  const tokens = useMcpTokens();
  const activity = useMcpActivity(8);
  const create = useCreateMcpToken();
  const revoke = useRevokeMcpToken();
  const me = useMe();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; kind: 'personal' | 'service'; scopes: string[] } | null>(null);
  const [minted, setMinted] = useState<{ name: string; secret: string; url: string } | null>(null);
  const [client, setClient] = useState<(typeof CLIENTS)[number][0]>('claude-desktop');
  const [copied, setCopied] = useState(false);
  const s = settings.data;
  if (settings.isError) return <div className="alert">Could not load settings: {settings.error.message}</div>;
  if (!s) return <p className="muted">Loading…</p>;
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const url = `${origin}${s.mcp.endpoint}`;
  const save = async (body: Record<string, unknown>) => {
    try {
      setError(null);
      await patch.mutateAsync(body);
    } catch (err) {
      setError(fieldError(err));
    }
  };
  const toggleScope = (scope: string) => {
    const next = s.mcp.defaultScopes.includes(scope) ? s.mcp.defaultScopes.filter((x) => x !== scope) : [...s.mcp.defaultScopes, scope];
    void save({ mcpDefaultScopes: next.join(',') });
  };
  const canPersonal = !!me.data?.user?.userName;
  const live = (tokens.data ?? []).filter((t) => !t.revokedAt);
  return (
    <>
      <SettingsHeader title="MCP server" lede="Let the AI assistants your team already uses — Claude, Cursor, anything that speaks MCP — read standups and work blockers. Nothing runs inside AsyncUp; there is no model, no key and no prompt to manage here." />
      {error ? <div className="alert" role="alert">{error}</div> : null}
      <SectionCard title="Server">
        <SettingsRow label="MCP server" hint="When disabled, every token stops working immediately. Tokens and scopes are kept so you can re-enable without reconfiguring clients.">
          <label className="row t-small">
            <input type="checkbox" checked={s.mcp.enabled} onChange={(e) => void save({ mcpEnabled: e.target.checked })} /> <span className={`badge ${s.mcp.enabled ? 'badge-success' : ''}`}>{s.mcp.enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </SettingsRow>
        <SettingsRow label="Endpoint" hint="Streamable HTTP · stateless">
          <span className="t-mono">{url}</span>
          <button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={async () => { setCopied(await copyText(url)); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy'}</button>
        </SettingsRow>
        <SettingsRow label="Check" hint="Whether the server is on and at least one token exists.">
          <button type="button" className="btn" style={{ height: 28 }} disabled={verify.isPending} onClick={() => verify.mutate(undefined)}>Verify</button>
          {verify.data || verify.isPending || verify.isError ? <div style={{ flexBasis: '100%' }}><VerifyStatus state={fromMutation(verify)} /></div> : null}
        </SettingsRow>
      </SectionCard>
      <SectionCard title="Default scopes" hint="What a new token gets when no scopes are chosen. Read-only by default; a token can always be narrower.">
        {Object.entries(s.mcp.scopes).map(([scope, help]) => (
          <SettingsRow key={scope} label={scope} hint={help}>
            <label className="row t-small"><input type="checkbox" checked={s.mcp.defaultScopes.includes(scope)} onChange={() => toggleScope(scope)} /> {s.mcp.defaultScopes.includes(scope) ? 'Default' : 'Off'}</label>
          </SettingsRow>
        ))}
      </SectionCard>
      <SectionCard title="Access tokens" hint="One token per person or per tool. Shown once at creation; expire 90 days after their last use." action={<button type="button" className="btn" style={{ height: 28 }} onClick={() => { setMinted(null); setForm({ name: '', kind: canPersonal ? 'personal' : 'service', scopes: s.mcp.defaultScopes }); }}>New token</button>}>
        {form ? (
          <div className="settings-row" style={{ gridTemplateColumns: '1fr' }}>
            <div className="field" style={{ maxWidth: 520 }}>
              <label htmlFor="token-name">Name</label>
              <input id="token-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Claude Desktop — Asha" />
              <span className="t-medium">Kind</span>
              <div className="chip-tabs">
                <button type="button" className="chip-tab" aria-pressed={form.kind === 'personal'} disabled={!canPersonal} onClick={() => setForm({ ...form, kind: 'personal' })}>Personal — acts as you</button>
                <button type="button" className="chip-tab" aria-pressed={form.kind === 'service'} disabled={me.data?.kind !== 'admin'} onClick={() => setForm({ ...form, kind: 'service', scopes: ['read'] })}>Service — read-only, admin</button>
              </div>
              <span className="t-medium">Scopes</span>
              <div className="chip-tabs">
                {Object.keys(s.mcp.scopes).map((scope) => (
                  <button key={scope} type="button" className="chip-tab" aria-pressed={form.scopes.includes(scope)} disabled={form.kind === 'service' && scope !== 'read'} onClick={() => setForm({ ...form, scopes: form.scopes.includes(scope) ? form.scopes.filter((x) => x !== scope) : [...form.scopes, scope] })}>{scope}</button>
                ))}
              </div>
              <div className="row">
                <button type="button" className="btn btn-primary" style={{ height: 28 }} disabled={!form.name.trim() || form.scopes.length === 0 || create.isPending} onClick={() => void (async () => {
                  try {
                    setError(null);
                    const t = await create.mutateAsync({ name: form.name.trim(), kind: form.kind, scopes: form.scopes });
                    setMinted({ name: t.name, secret: t.secret, url: t.config.url });
                    setForm(null);
                  } catch (err) {
                    setError(fieldError(err));
                  }
                })()}>Create token</button>
                <button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={() => setForm(null)}>Cancel</button>
              </div>
            </div>
          </div>
        ) : null}
        {minted ? (
          <div className="settings-row" style={{ gridTemplateColumns: '1fr' }}>
            <div className="secret" role="status">
              <div className="t-medium">Token for {minted.name} — copy it now, it will not be shown again.</div>
              <CopyRow label="Token" value={minted.secret} />
            </div>
          </div>
        ) : null}
        {tokens.isError ? <div className="settings-row"><div className="alert">Could not load tokens: {tokens.error.message}</div></div> : null}
        {tokens.data && live.length === 0 && !form ? <div className="settings-row t-small muted">No tokens yet.</div> : null}
        {live.map((t) => (
          <div key={t.id} className="settings-row" style={{ gridTemplateColumns: '1fr auto auto auto' }}>
            <div>
              <div className="t-medium">{t.name}</div>
              <div className="t-caption">{t.kind === 'service' ? 'service' : t.owner?.displayName ?? t.owner?.userName ?? 'personal'}</div>
            </div>
            <span className="badge">{t.scopes.join(' · ')}</span>
            <span className="t-caption">{t.lastUsedAt ? `Last used ${ago(Date.now() - Date.parse(t.lastUsedAt))}` : 'Never used'}</span>
            <button type="button" className="btn btn-ghost btn-danger" style={{ height: 28 }} disabled={revoke.isPending} onClick={() => void revoke.mutateAsync(t.id).catch((err: unknown) => setError(fieldError(err)))}>Revoke</button>
          </div>
        ))}
      </SectionCard>
      <SectionCard title="Connect a client" hint="Paste this into the assistant’s MCP configuration. The token is shown once at creation.">
        <div className="settings-row" style={{ gridTemplateColumns: '1fr' }}>
          <div className="chip-tabs" role="tablist" aria-label="Client">
            {CLIENTS.map(([id, label]) => <button key={id} type="button" role="tab" className="chip-tab" aria-pressed={client === id} aria-selected={client === id} onClick={() => setClient(id)}>{label}</button>)}
          </div>
          <pre className="t-mono card" style={{ margin: 0, padding: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{clientSnippet(client, url, minted?.secret)}</pre>
          <div><button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={() => void copyText(clientSnippet(client, url, minted?.secret))}>Copy snippet</button></div>
        </div>
      </SectionCard>
      <SectionCard title="Recent activity">
        {activity.data?.length === 0 ? <div className="settings-row t-small muted">No calls yet.</div> : null}
        {activity.data?.map((a) => (
          <div key={a.id} className="settings-row" style={{ gridTemplateColumns: '110px 180px 1fr' }}>
            <span className="t-caption">{clock(a.at, Intl.DateTimeFormat().resolvedOptions().timeZone)}</span>
            <span className="t-small">{a.token.name}</span>
            <span className={`t-mono ${a.ok ? '' : 'badge-danger'}`} style={{ overflowWrap: 'anywhere' }}>{a.tool} {a.argsSummary}{a.ok ? '' : ' · refused'}</span>
          </div>
        ))}
      </SectionCard>
    </>
  );
}
