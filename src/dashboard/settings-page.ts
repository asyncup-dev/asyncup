import type { AppSettings, SettingsService } from '../core/settings.js';
import { HTTPS_URL_RE, isValidZone, looksLikeEmail } from '../core/validation.js';
import { DEFAULT_ANTHROPIC_MODEL } from '../ai/llm.js';
import { esc } from './chrome.js';

/** The app-settings form: section handlers + the rendered page. */

export async function applySettings(settings: SettingsService, body: any): Promise<string | null> {
  const section = String(body.section ?? '');

  if (section === 'chat') {
    const chatAudience = String(body.chatAudience ?? '').trim();
    // Accepts the GCP project number and/or the app URL (Chat API "Audience"
    // can be either) — space/comma separated. Reject obvious mistakes like
    // the project ID slug or org ID being pasted as the only value.
    const auds = chatAudience.split(/[\s,]+/).filter(Boolean);
    const bad = auds.find((a) => !/^\d+$/.test(a) && !HTTPS_URL_RE.test(a));
    if (bad) {
      return `"${bad}" isn't a GCP project number or an https app URL. Use the project number (digits) or the Chat app's HTTP endpoint URL — not the project ID slug or org ID.`;
    }
    const json = String(body.serviceAccountJson ?? '').trim();
    if (json) {
      try {
        const parsed = JSON.parse(json);
        if (!parsed.client_email || !parsed.private_key) {
          return 'That JSON is missing client_email / private_key — paste the full service-account key file.';
        }
      } catch {
        return 'The service-account key must be valid JSON — paste the whole downloaded file.';
      }
    }
    await settings.update({ chatAudience, ...(json ? { serviceAccountJson: json } : {}) });
    if (body.clear_serviceAccountJson === 'on') await settings.update({ serviceAccountJson: '' });
    return null;
  }

  if (section === 'ai') {
    const llmProvider = String(body.llmProvider ?? '');
    if (!['', 'anthropic', 'openai'].includes(llmProvider)) return 'Unknown AI provider.';
    const llmModel = String(body.llmModel ?? '').trim();
    const key = String(body.llmApiKey ?? '').trim();
    if (llmProvider === 'openai' && !llmModel) return 'OpenAI needs an explicit model name.';
    await settings.update({
      llmProvider: llmProvider as AppSettings['llmProvider'],
      llmModel,
      ...(key ? { llmApiKey: key } : {}),
    });
    if (body.clear_llmApiKey === 'on') await settings.update({ llmApiKey: '' });
    return null;
  }

  if (section === 'oauth') {
    const clientId = String(body.oauthClientId ?? '').trim();
    const secret = String(body.oauthClientSecret ?? '').trim();
    if (clientId && !clientId.endsWith('.apps.googleusercontent.com')) {
      return 'That does not look like an OAuth client ID (expected ….apps.googleusercontent.com).';
    }
    await settings.update({ oauthClientId: clientId, ...(secret ? { oauthClientSecret: secret } : {}) });
    if (body.clear_oauthClientSecret === 'on') await settings.update({ oauthClientSecret: '' });
    return null;
  }

  if (section === 'saml') {
    const ssoUrl = String(body.samlIdpSsoUrl ?? '').trim();
    const cert = String(body.samlIdpCert ?? '').trim();
    if (ssoUrl && !HTTPS_URL_RE.test(ssoUrl)) return 'The IdP SSO URL must be https://.';
    if (cert && !cert.includes('CERTIFICATE') && !/^[A-Za-z0-9+/=\s]+$/.test(cert)) {
      return 'The IdP certificate should be the PEM (or base64) X.509 certificate from your IdP.';
    }
    // Empty attribute/group values delete the row, falling back to the
    // SETTING_DEFAULTS — no fallback literals here.
    await settings.update({
      samlIdpEntityId: String(body.samlIdpEntityId ?? '').trim(),
      samlIdpSsoUrl: ssoUrl,
      samlIdpCert: cert,
      samlAdminAttribute: String(body.samlAdminAttribute ?? '').trim(),
      samlAdminGroup: String(body.samlAdminGroup ?? '').trim(),
    });
    return null;
  }

  if (section === 'workspace') {
    const tz = String(body.defaultTimezone ?? '').trim();
    if (!isValidZone(tz)) return `Invalid IANA timezone: ${tz || '(empty)'} — e.g. Asia/Kolkata.`;
    const adminEmail = String(body.workspaceAdminEmail ?? '').trim();
    if (adminEmail && !looksLikeEmail(adminEmail)) {
      return `"${adminEmail}" doesn't look like an email address.`;
    }
    await settings.update({
      defaultTimezone: tz,
      calendarOoo: body.calendarOoo === 'on',
      workspaceAdminEmail: adminEmail,
    });
    return null;
  }

  return 'Unknown settings section.';
}

function secretStatus(value: string, describe?: (v: string) => string): string {
  if (!value) return '<span class="chip off">Not set</span>';
  const detail = describe ? describe(value) : `ends in <code>${esc(value.slice(-4))}</code>`;
  return `<span class="chip on">Configured</span> <small class="muted">${detail}</small>`;
}

export async function settingsPage(
  s: AppSettings,
  saved: boolean,
  error: string | null,
  revealed: { field: string; value: string } | null,
): Promise<string> {
  const saJsonStatus = secretStatus(s.serviceAccountJson, (v) => {
    try {
      return `key for <code>${esc(JSON.parse(v).client_email ?? 'unknown')}</code>`;
    } catch {
      return 'stored';
    }
  });

  const tokenRow = (field: 'tickToken' | 'exportToken' | 'scimToken', title: string, hint: string) => {
    const value = s[field];
    const which = field === 'tickToken' ? 'tick' : field === 'exportToken' ? 'export' : 'scim';
    const reveal =
      revealed?.field === field
        ? `<div class="reveal">New token (copy now — it won't be shown again):<code>${esc(revealed.value)}</code></div>`
        : '';
    return `<div class="token-row">
      <div><b>${title}</b><small class="muted">${hint}</small><div>${secretStatus(value)}</div>${reveal}</div>
      <div class="token-actions">
        <form method="post" action="/dashboard/settings"><button class="btn ghost" name="action" value="generate-${which}">↻ Generate</button></form>
        ${value ? `<form method="post" action="/dashboard/settings"><button class="btn ghost danger" name="action" value="clear-${which}">Clear</button></form>` : ''}
      </div>
    </div>`;
  };

  return `
  <div class="kicker">Configuration</div>
  <h1>Settings</h1>
  <p class="muted">Stored in your database; secrets are encrypted with your <code>SECRET_KEY</code>. Changes apply immediately — no restart.</p>
  ${saved ? '<div class="toast ok">✓ Saved</div>' : ''}
  ${error ? `<div class="toast err">⚠ ${esc(error)}</div>` : ''}

  <form method="post" action="/dashboard/settings" class="card">
    <input type="hidden" name="section" value="chat">
    <div class="kicker">01 · Google Chat</div>
    <h2>Workspace connection</h2>
    <label>Audience — GCP project <em>number</em> (or app URL)
      <input name="chatAudience" value="${esc(s.chatAudience)}" placeholder="e.g. 819177304171">
      <small class="muted">Verifies webhook calls come from Google Chat. Use the project <b>number</b> (digits, from
      Cloud overview → Project info — <em>not</em> the project ID or org ID). If your Chat API "Audience" is set to
      the App URL instead, paste that URL; you can enter both, space-separated.</small>
    </label>
    <label>Service-account key (JSON)
      <textarea name="serviceAccountJson" rows="4" placeholder='${s.serviceAccountJson ? 'Paste a new key to replace the stored one' : '{ "type": "service_account", … } — paste the downloaded key file'}'></textarea>
      <small>${saJsonStatus}${s.serviceAccountJson ? ' · <label class="inline"><input type="checkbox" name="clear_serviceAccountJson"> clear stored key (use ADC)</label>' : ' · <span class="muted">empty = Application Default Credentials</span>'}</small>
    </label>
    <button class="btn" type="submit">Save connection</button>
  </form>

  <form method="post" action="/dashboard/settings" class="card">
    <input type="hidden" name="section" value="ai">
    <div class="kicker">02 · AI summaries</div>
    <h2>Bring your own key</h2>
    <label>Provider
      <select name="llmProvider">
        <option value="" ${s.llmProvider === '' ? 'selected' : ''}>Off</option>
        <option value="anthropic" ${s.llmProvider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
        <option value="openai" ${s.llmProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
      </select>
    </label>
    <label>API key
      <input name="llmApiKey" type="password" placeholder="${s.llmApiKey ? 'Enter a new key to replace the stored one' : 'sk-…'}" autocomplete="off">
      <small>${secretStatus(s.llmApiKey)}${s.llmApiKey ? ' · <label class="inline"><input type="checkbox" name="clear_llmApiKey"> clear</label>' : ''}</small>
    </label>
    <label>Model
      <input name="llmModel" value="${esc(s.llmModel)}" placeholder="anthropic default: ${DEFAULT_ANTHROPIC_MODEL}">
    </label>
    <small class="muted">Then enable per standup with <code>@AsyncUp ai on</code>.</small>
    <button class="btn" type="submit">Save AI settings</button>
  </form>

  <form method="post" action="/dashboard/settings" class="card">
    <input type="hidden" name="section" value="workspace">
    <div class="kicker">03 · Workspace</div>
    <h2>Defaults &amp; integrations</h2>
    <label>Default timezone for new standups
      <input name="defaultTimezone" value="${esc(s.defaultTimezone)}" placeholder="Asia/Kolkata">
    </label>
    <label class="inline big"><input type="checkbox" name="calendarOoo" ${s.calendarOoo ? 'checked' : ''}>
      Google Calendar OOO sync <small class="muted">auto-mark people away on out-of-office days (needs the service-account key + domain-wide delegation)</small>
    </label>
    <label>Workspace admin email
      <input name="workspaceAdminEmail" value="${esc(s.workspaceAdminEmail)}" placeholder="admin@yourdomain.com (optional)">
      <small class="muted">Enables Directory API lookups (impersonated for reads; needs the
      <code>admin.directory.user.readonly</code> scope in domain-wide delegation). With it, Calendar OOO works
      for people who never interacted with the bot.</small>
    </label>
    <button class="btn" type="submit">Save workspace</button>
  </form>

  <form method="post" action="/dashboard/settings" class="card">
    <input type="hidden" name="section" value="oauth">
    <div class="kicker">04 · Sign in with Google</div>
    <h2>Admin &amp; user consoles</h2>
    <label>OAuth client ID
      <input name="oauthClientId" value="${esc(s.oauthClientId)}" placeholder="….apps.googleusercontent.com">
    </label>
    <label>OAuth client secret
      <input name="oauthClientSecret" type="password" placeholder="${s.oauthClientSecret ? 'Enter a new secret to replace the stored one' : 'GOCSPX-…'}" autocomplete="off">
      <small>${secretStatus(s.oauthClientSecret)}${s.oauthClientSecret ? ' · <label class="inline"><input type="checkbox" name="clear_oauthClientSecret"> clear</label>' : ''}</small>
    </label>
    <small class="muted">Create a <b>Web application</b> OAuth client (GCP → APIs &amp; Services → Credentials) with
    redirect URI <code>https://&lt;your-host&gt;/auth/callback</code>. Workspace admins (per the Directory API)
    get this admin console; everyone else gets their personal <code>/me</code> console. Set the
    <b>Workspace admin email</b> above so admin status can be looked up.</small>
    <button class="btn" type="submit">Save sign-in</button>
  </form>

  <form method="post" action="/dashboard/settings" class="card">
    <input type="hidden" name="section" value="saml">
    <div class="kicker">05 · Enterprise SSO (SAML)</div>
    <h2>Bring your own IdP</h2>
    <label>IdP entity ID <input name="samlIdpEntityId" value="${esc(s.samlIdpEntityId)}" placeholder="e.g. https://accounts.google.com/o/saml2?idpid=…"></label>
    <label>IdP SSO URL <input name="samlIdpSsoUrl" value="${esc(s.samlIdpSsoUrl)}" placeholder="https://…/sso/saml"></label>
    <label>IdP certificate (X.509 PEM)
      <textarea name="samlIdpCert" rows="4" placeholder="-----BEGIN CERTIFICATE-----">${esc(s.samlIdpCert)}</textarea>
    </label>
    <label>Admin attribute <input name="samlAdminAttribute" value="${esc(s.samlAdminAttribute)}"> <small class="muted">assertion attribute checked for the admin group</small></label>
    <label>Admin group value <input name="samlAdminGroup" value="${esc(s.samlAdminGroup)}"> <small class="muted">members get the admin console; Google Directory admins always do</small></label>
    <small class="muted">Point your IdP's custom SAML app at ACS URL <code>https://&lt;your-host&gt;/auth/saml/acs</code>
    with entity ID <code>https://&lt;your-host&gt;/auth/saml/metadata</code> (SP metadata is served at that URL).
    Works with Google Workspace, Okta, Entra, OneLogin — all in the open-source core.</small>
    <button class="btn" type="submit">Save SAML</button>
  </form>

  <section class="card">
    <div class="kicker">06 · Access tokens</div>
    <h2>Machine endpoints</h2>
    ${tokenRow('tickToken', 'Scheduler tick token', 'Authorizes POST /tick for external cron (scale-to-zero deploys).')}
    ${tokenRow('exportToken', 'CSV export token', 'Enables GET /export. Endpoint stays off until a token exists.')}
    ${tokenRow('scimToken', 'SCIM provisioning token', 'Bearer token for /scim/v2 (Okta, Entra, OneLogin). Deactivating a user there removes them from every roster.')}
  </section>`;
}
