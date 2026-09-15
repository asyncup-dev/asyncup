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
    // Master toggle: unchecked turns the feature off regardless of the
    // (CSS-hidden but still submitted) fields below it.
    if (body.aiOn !== 'on') {
      await settings.update({ llmProvider: '', llmModel: '' });
      if (body.clear_llmApiKey === 'on') await settings.update({ llmApiKey: '' });
      return null;
    }
    const llmProvider = String(body.llmProvider ?? 'anthropic');
    if (!['anthropic', 'openai'].includes(llmProvider)) return 'Unknown AI provider.';
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
  const saEmail = (() => {
    try {
      return JSON.parse(s.serviceAccountJson).client_email ?? '';
    } catch {
      return '';
    }
  })();

  const chip = (on: boolean, onText: string, offText = 'Off') =>
    `<span class="chip ${on ? 'on' : 'off'}">${esc(on ? onText : offText)}</span>`;

  /** Accordion section: title + one-liner + status chip visible while collapsed. */
  const section = (opts: { title: string; desc: string; status: string; open?: boolean; body: string }) =>
    `<details class="card acc"${opts.open ? ' open' : ''}>
      <summary>
        <span class="sum-title">${esc(opts.title)}</span>
        <span class="sum-desc">${esc(opts.desc)}</span>
        <span class="sum-status">${opts.status}</span>
      </summary>
      <div class="acc-body">${opts.body}</div>
    </details>`;

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

  const chatConfigured = !!(s.chatAudience && s.serviceAccountJson);
  const chatBody = `<form method="post" action="/dashboard/settings">
    <input type="hidden" name="section" value="chat">
    <label>Audience
      <input class="wide" name="chatAudience" value="${esc(s.chatAudience)}" placeholder="GCP project number, e.g. 123456789012">
      <small class="muted">Verifies events really come from Google Chat — the project <b>number</b> and/or the app URL, space-separated.</small>
    </label>
    <details class="hint"><summary>What goes here?</summary>
      <p>Use the project <b>number</b> (digits, Cloud overview → Project info) — <em>not</em> the project ID slug or
      org ID. If your Chat app configuration shows the <em>App URL</em> as its audience, paste that URL; entering
      both covers either behaviour.</p>
    </details>
    <label>Service-account key (JSON)
      <textarea name="serviceAccountJson" rows="4" placeholder='${s.serviceAccountJson ? 'Paste a new key to replace the stored one' : '{ "type": "service_account", … } — paste the whole downloaded key file'}'></textarea>
      <small>${secretStatus(s.serviceAccountJson, () => `key for <code>${esc(saEmail || 'unknown')}</code>`)}${s.serviceAccountJson ? ' · <label class="inline"><input type="checkbox" name="clear_serviceAccountJson"> clear stored key (use ADC)</label>' : ' · <span class="muted">empty = Application Default Credentials</span>'}</small>
    </label>
    <button class="btn" type="submit">Save connection</button>
  </form>`;

  const workspaceBody = `<form method="post" action="/dashboard/settings">
    <input type="hidden" name="section" value="workspace">
    <label>Default timezone for new standups
      <input name="defaultTimezone" value="${esc(s.defaultTimezone)}" placeholder="Asia/Kolkata">
    </label>
    <label class="inline big"><input type="checkbox" name="calendarOoo" ${s.calendarOoo ? 'checked' : ''}>
      Google Calendar OOO sync <small class="muted">auto-mark people away on out-of-office days (activates once the service-account key has domain-wide delegation)</small>
    </label>
    <label>Workspace admin email
      <input name="workspaceAdminEmail" value="${esc(s.workspaceAdminEmail)}" placeholder="admin@yourdomain.com (optional)">
      <small class="muted">Enables Directory lookups: emails resolve for everyone (OOO works before first bot contact) and Workspace admins are recognised by the consoles. Needs <code>admin.directory.user.readonly</code> in domain-wide delegation.</small>
    </label>
    <button class="btn" type="submit">Save workspace</button>
  </form>`;

  const googleOn = !!(s.oauthClientId && s.oauthClientSecret);
  const samlOn = !!(s.samlIdpEntityId && s.samlIdpSsoUrl && s.samlIdpCert);
  const signInBody = `<p class="muted" style="margin-top:0">Two routes into the same consoles — most installs need
    <b>one</b>. Google sign-in is the zero-friction choice for Google-native Workspaces; SAML is for orgs fronted by
    Okta, Entra or another IdP. Workspace admins land in this admin console; everyone else gets their personal
    <code>/me</code> page.</p>
  <details class="sub"${!samlOn ? ' open' : ''}>
    <summary><span class="sum-title">Google sign-in</span><span class="sum-desc">recommended for Google-native orgs</span><span class="sum-status">${chip(googleOn, 'Configured')}</span></summary>
    <form method="post" action="/dashboard/settings">
      <input type="hidden" name="section" value="oauth">
      <label>OAuth client ID
        <input class="wide" name="oauthClientId" value="${esc(s.oauthClientId)}" placeholder="….apps.googleusercontent.com">
      </label>
      <label>OAuth client secret
        <input name="oauthClientSecret" type="password" placeholder="${s.oauthClientSecret ? 'Enter a new secret to replace the stored one' : 'GOCSPX-…'}" autocomplete="off">
        <small>${secretStatus(s.oauthClientSecret)}${s.oauthClientSecret ? ' · <label class="inline"><input type="checkbox" name="clear_oauthClientSecret"> clear</label>' : ''}</small>
      </label>
      <small class="muted">Create a <b>Web application</b> OAuth client (GCP → APIs &amp; Services → Credentials) with
      redirect URI <code>https://&lt;your-host&gt;/auth/callback</code>.</small>
      <div><button class="btn" type="submit">Save Google sign-in</button></div>
    </form>
  </details>
  <details class="sub">
    <summary><span class="sum-title">SAML SSO</span><span class="sum-desc">Okta, Entra, OneLogin, any IdP</span><span class="sum-status">${chip(samlOn, 'Configured')}</span></summary>
    <form method="post" action="/dashboard/settings">
      <input type="hidden" name="section" value="saml">
      <label>IdP entity ID <input class="wide" name="samlIdpEntityId" value="${esc(s.samlIdpEntityId)}" placeholder="e.g. https://accounts.google.com/o/saml2?idpid=…"></label>
      <label>IdP SSO URL <input class="wide" name="samlIdpSsoUrl" value="${esc(s.samlIdpSsoUrl)}" placeholder="https://…/sso/saml"></label>
      <label>IdP certificate (X.509 PEM)
        <textarea name="samlIdpCert" rows="4" placeholder="-----BEGIN CERTIFICATE-----">${esc(s.samlIdpCert)}</textarea>
      </label>
      <label>Admin attribute <input name="samlAdminAttribute" value="${esc(s.samlAdminAttribute)}"> <small class="muted">assertion attribute checked for the admin group</small></label>
      <label>Admin group value <input name="samlAdminGroup" value="${esc(s.samlAdminGroup)}"> <small class="muted">members get the admin console; Google Directory admins always do</small></label>
      <small class="muted">Point your IdP's custom SAML app at ACS URL <code>https://&lt;your-host&gt;/auth/saml/acs</code>
      with entity ID <code>https://&lt;your-host&gt;/auth/saml/metadata</code> (SP metadata served there).</small>
      <div><button class="btn" type="submit">Save SAML</button></div>
    </form>
  </details>`;

  const aiOn = !!s.llmProvider;
  const aiBody = `<form method="post" action="/dashboard/settings" class="ai-form">
    <input type="hidden" name="section" value="ai">
    <label class="inline big"><input type="checkbox" name="aiOn" ${aiOn ? 'checked' : ''}>
      Enable AI summaries <small class="muted">daily TL;DR + week-in-review, via your own key — nothing leaves your infra otherwise</small>
    </label>
    <div class="gated">
      <label>Provider
        <select name="llmProvider">
          <option value="anthropic" ${s.llmProvider !== 'openai' ? 'selected' : ''}>Anthropic</option>
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
    </div>
    <button class="btn" type="submit">Save AI settings</button>
  </form>`;

  const tokensSet = [s.tickToken, s.exportToken, s.scimToken].filter(Boolean).length;
  const tokensBody = `${tokenRow('tickToken', 'Scheduler tick token', 'Authorizes POST /tick for external cron (scale-to-zero deploys).')}
    ${tokenRow('exportToken', 'CSV export token', 'Enables GET /export. Endpoint stays off until a token exists.')}
    ${tokenRow('scimToken', 'SCIM provisioning token', 'Bearer token for /scim/v2 (Okta, Entra, OneLogin). Deactivating a user there removes them from every roster.')}`;

  return `
  <div class="kicker">Configuration</div>
  <h1>Settings</h1>
  <p class="muted">Stored in your database; secrets are encrypted with your <code>SECRET_KEY</code>. Changes apply immediately — no restart.</p>
  ${saved ? '<div class="toast ok">✓ Saved</div>' : ''}
  ${error ? `<div class="toast err">⚠ ${esc(error)}</div>` : ''}
  ${section({
    title: 'Google Chat',
    desc: 'the connection that makes everything work',
    status: chatConfigured ? chip(true, saEmail || 'Connected') : chip(false, '', 'Action needed'),
    open: !chatConfigured,
    body: chatBody,
  })}
  ${section({ title: 'Workspace', desc: 'defaults & Google integrations', status: chip(true, s.defaultTimezone), body: workspaceBody })}
  ${section({
    title: 'Sign-in & consoles',
    desc: 'web access for admins and the team',
    status: googleOn || samlOn ? chip(true, [googleOn && 'Google', samlOn && 'SAML'].filter(Boolean).join(' + ')) : chip(false, '', 'Token only'),
    body: signInBody,
  })}
  ${section({ title: 'AI summaries', desc: 'bring your own key', status: aiOn ? chip(true, `On · ${s.llmProvider}`) : chip(false, '', 'Off'), body: aiBody })}
  ${section({ title: 'Access tokens', desc: 'machine endpoints: /tick, /export, /scim', status: chip(tokensSet > 0, `${tokensSet} set`, 'None set'), open: !!revealed, body: tokensBody })}`;
}
