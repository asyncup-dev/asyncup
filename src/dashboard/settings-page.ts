import type { AppSettings, SettingsService } from '../core/settings.js';
import {
  badAdminEmail,
  badAudience,
  badOauthId,
  badSaKey,
  badSamlCert,
  badSamlSsoUrl,
  badTimezone,
  BOOL_FIELDS,
  FIELD_CHECKS,
  googleSignInOn,
  LOCKOUT_MSG,
  locksOut,
  samlSignInOn,
  SECRET_FIELDS,
  TOKEN_OFF_MSG,
} from '../core/settings-rules.js';
import { esc } from './chrome.js';

/**
 * App settings: one box per value on the settings page, grouped forms for the
 * setup walkthrough. Both paths share the per-field checks below.
 */

export { googleSignInOn, samlSignInOn } from '../core/settings-rules.js';

// ---------- save paths ----------

export async function applySettings(settings: SettingsService, body: any): Promise<string | null> {
  const s = await settings.get();
  const staged = stageChange(s, body);
  if (typeof staged === 'string') return staged;
  // The lockout guard runs on every save, whichever form was submitted —
  // no input can select a path around it.
  if (locksOut(s, staged)) return LOCKOUT_MSG;
  if (Object.keys(staged).length) await settings.update(staged);
  return null;
}

/** Validate one submitted form and stage its change — no writes here. */
type Staged = Partial<AppSettings> | string;

function stageChat(_s: AppSettings, body: any): Staged {
  const chatAudience = String(body.chatAudience ?? '').trim();
  const audErr = badAudience(chatAudience);
  if (audErr) return audErr;
  const json = String(body.serviceAccountJson ?? '').trim();
  if (json) {
    const keyErr = badSaKey(json);
    if (keyErr) return keyErr;
  }
  return {
    chatAudience,
    ...(json ? { serviceAccountJson: json } : {}),
    ...(body.clear_serviceAccountJson === 'on' ? { serviceAccountJson: '' } : {}),
  };
}

function stageOauth(_s: AppSettings, body: any): Staged {
  const clientId = String(body.oauthClientId ?? '').trim();
  const idErr = badOauthId(clientId);
  if (idErr) return idErr;
  const secret = String(body.oauthClientSecret ?? '').trim();
  return {
    oauthClientId: clientId,
    ...(secret ? { oauthClientSecret: secret } : {}),
    ...(body.clear_oauthClientSecret === 'on' ? { oauthClientSecret: '' } : {}),
  };
}

function stageSaml(_s: AppSettings, body: any): Staged {
  const ssoUrl = String(body.samlIdpSsoUrl ?? '').trim();
  const cert = String(body.samlIdpCert ?? '').trim();
  const err = badSamlSsoUrl(ssoUrl) ?? badSamlCert(cert);
  if (err) return err;
  // Empty attribute/group values delete the row, falling back to the
  // SETTING_DEFAULTS — no fallback literals here.
  return {
    samlIdpEntityId: String(body.samlIdpEntityId ?? '').trim(),
    samlIdpSsoUrl: ssoUrl,
    samlIdpCert: cert,
    samlAdminAttribute: String(body.samlAdminAttribute ?? '').trim(),
    samlAdminGroup: String(body.samlAdminGroup ?? '').trim(),
  };
}

function stageWorkspace(_s: AppSettings, body: any): Staged {
  const tz = String(body.defaultTimezone ?? '').trim();
  const tzErr = badTimezone(tz);
  if (tzErr) return tzErr;
  const adminEmail = String(body.workspaceAdminEmail ?? '').trim();
  const emailErr = badAdminEmail(adminEmail);
  if (emailErr) return emailErr;
  return {
    defaultTimezone: tz,
    calendarOoo: body.calendarOoo === 'on',
    workspaceAdminEmail: adminEmail,
  };
}

/**
 * 'field' is the settings page (one box, one value); the rest are the
 * setup walkthrough's grouped step forms.
 */
const SECTION_STAGERS: Record<string, (s: AppSettings, body: any) => Staged> = {
  field: stageField,
  chat: stageChat,
  oauth: stageOauth,
  saml: stageSaml,
  workspace: stageWorkspace,
};

function stageChange(s: AppSettings, body: any): Staged {
  const section = String(body.section ?? '');
  if (!Object.hasOwn(SECTION_STAGERS, section)) return 'Unknown settings section.';
  return SECTION_STAGERS[section]!(s, body);
}

function stageField(s: AppSettings, body: any): Partial<AppSettings> | string {
  const key = String(body.key ?? '');
  if (!BOOL_FIELDS.has(key as keyof AppSettings) && !(key in FIELD_CHECKS)) return 'Unknown setting.';

  if (BOOL_FIELDS.has(key as keyof AppSettings)) {
    const on = body.value === 'on';
    if (key === 'tokenSignIn' && !on && !googleSignInOn(s) && !samlSignInOn(s)) {
      // Friendlier wording than the generic lockout message; the guard in
      // applySettings would refuse this change regardless.
      return TOKEN_OFF_MSG;
    }
    return { [key]: on };
  }

  const value = String(body.value ?? '').trim();
  if (SECRET_FIELDS.has(key as keyof AppSettings)) {
    if (body.clear === 'on') return { [key]: '' };
    if (!value) return {}; // empty box = keep the stored secret
  }
  if (value) {
    const err = FIELD_CHECKS[key as keyof AppSettings]!(value);
    if (err) return err;
  }
  return { [key]: value };
}

// ---------- rendering ----------

function secretStatus(value: string, describe?: (v: string) => string): string {
  if (!value) return '<span class="chip off">Not set</span>';
  const detail = describe ? describe(value) : `ends in <code>${esc(value.slice(-4))}</code>`;
  return `<span class="chip on">Configured</span> <small class="muted">${detail}</small>`;
}

const chip = (on: boolean, onText: string, offText = 'Off') =>
  `<span class="chip ${on ? 'on' : 'off'}">${esc(on ? onText : offText)}</span>`;

/** One value, one box: its own form, hint, status and save button. */
function box(opts: {
  key: string;
  label: string;
  hint?: string;
  status?: string;
  control: string;
  extra?: string;
  cls?: string;
}): string {
  return `<div class="field${opts.cls ? ` ${opts.cls}` : ''}">
    <form method="post" action="/dashboard/settings">
      <input type="hidden" name="section" value="field">
      <input type="hidden" name="key" value="${esc(opts.key)}">
      <div class="f-head"><span class="f-label">${esc(opts.label)}</span>${opts.status ?? ''}</div>
      ${opts.hint ? `<p class="f-hint">${opts.hint}</p>` : ''}
      <div class="f-row">${opts.control}<button class="btn save" type="submit">Save</button></div>
      ${opts.extra ?? ''}
    </form>
  </div>`;
}

const textControl = (value: string, placeholder: string, type = 'text'): string =>
  `<input name="value" type="${type}" value="${type === 'password' ? '' : esc(value)}" placeholder="${esc(placeholder)}" ${type === 'password' ? 'autocomplete="off"' : ''}>`;

const toggleControl = (on: boolean, text: string): string =>
  `<label class="inline" style="flex:1;margin:0"><input type="checkbox" name="value" ${on ? 'checked' : ''}> ${text}</label>`;

const clearExtra = (set: boolean, text = 'clear stored value'): string =>
  set ? `<label class="inline f-clear"><input type="checkbox" name="clear"> ${esc(text)}</label>` : '';

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
    return `<div class="field token-row">
      <div><div class="f-head"><span class="f-label">${title}</span>${secretStatus(value)}</div><p class="f-hint">${hint}</p>${reveal}</div>
      <div class="token-actions">
        <form method="post" action="/dashboard/settings"><button class="btn ghost" name="action" value="generate-${which}">↻ Generate</button></form>
        ${value ? `<form method="post" action="/dashboard/settings"><button class="btn ghost danger" name="action" value="clear-${which}">Clear</button></form>` : ''}
      </div>
    </div>`;
  };

  // --- Google Chat ---
  const chatConfigured = !!(s.chatAudience && s.serviceAccountJson);
  const chatBody =
    box({
      key: 'chatAudience',
      label: 'Audience',
      hint: 'Verifies events really come from Google Chat — the GCP project <b>number</b> (digits, Cloud overview → Project info) and/or the Chat app URL, space-separated. Not the project ID slug or org ID.',
      status: chip(!!s.chatAudience, 'Set', 'Action needed'),
      control: textControl(s.chatAudience, 'GCP project number, e.g. 123456789012'),
    }) +
    box({
      key: 'serviceAccountJson',
      label: 'Service-account key (JSON)',
      hint: 'How AsyncUp talks back to Chat. Empty = Application Default Credentials.',
      status: secretStatus(s.serviceAccountJson, () => `key for <code>${esc(saEmail || 'unknown')}</code>`),
      control: `<textarea name="value" rows="4" placeholder='${s.serviceAccountJson ? 'Paste a new key to replace the stored one' : '{ "type": "service_account", … } — paste the whole downloaded key file'}'></textarea>`,
      extra: clearExtra(!!s.serviceAccountJson, 'clear stored key (use ADC)'),
    });

  // --- Workspace ---
  const workspaceBody =
    box({
      key: 'defaultTimezone',
      label: 'Default timezone',
      hint: 'Used for new standups.',
      control: textControl(s.defaultTimezone, 'Asia/Kolkata'),
    }) +
    box({
      key: 'calendarOoo',
      label: 'Google Calendar OOO sync',
      hint: 'Auto-mark people away on out-of-office days (activates once the service-account key has domain-wide delegation).',
      status: chip(s.calendarOoo, 'On'),
      control: toggleControl(s.calendarOoo, 'Enabled'),
    }) +
    box({
      key: 'workspaceAdminEmail',
      label: 'Workspace admin email',
      hint: 'Enables Directory lookups: emails resolve for everyone (OOO works before first bot contact) and Workspace admins are recognised by the consoles. Needs <code>admin.directory.user.readonly</code> in domain-wide delegation.',
      status: chip(!!s.workspaceAdminEmail, 'Set', 'Not set'),
      control: textControl(s.workspaceAdminEmail, 'admin@yourdomain.com (optional)'),
    });

  // --- Sign-in & consoles ---
  const googleOn = googleSignInOn(s);
  const samlOn = samlSignInOn(s);
  const tokenLocked = !googleOn && !samlOn;
  const tokenBox = tokenLocked
    ? `<div class="field">
        <div class="f-head"><span class="f-label">Token sign-in</span>${chip(true, 'On — required')}</div>
        <p class="f-hint">The <code>DASHBOARD_TOKEN</code> from the server environment. It can be switched off
        once Google or SAML sign-in works — right now it is the only way in.</p>
      </div>`
    : box({
        key: 'tokenSignIn',
        label: 'Token sign-in',
        hint: `Accept the <code>DASHBOARD_TOKEN</code> on the sign-in page. Safe to turn off now that ${googleOn ? 'Google' : 'SAML'} sign-in works. Locked out later? Re-enable it in the database: <code>DELETE FROM settings WHERE key='tokenSignIn'</code>.`,
        status: chip(s.tokenSignIn, 'On'),
        control: toggleControl(s.tokenSignIn, 'Allow the operator token'),
      });

  const signInBody = `<p class="muted" style="margin-top:0">Web access for admins and the team — most installs need
    <b>one</b> method besides the token. Google sign-in is the zero-friction choice for Google-native Workspaces; SAML
    is for orgs fronted by Okta, Entra or another IdP. Workspace admins land in this admin console; everyone else gets
    their personal <code>/me</code> page.</p>
  ${tokenBox}
  <h3 class="subhead">Google sign-in</h3>
  ${box({
    key: 'oauthClientId',
    label: 'OAuth client ID',
    hint: 'Create a <b>Web application</b> OAuth client (GCP → APIs &amp; Services → Credentials) with redirect URI <code>https://&lt;your-host&gt;/auth/callback</code>.',
    status: chip(!!s.oauthClientId, 'Set', 'Not set'),
    control: textControl(s.oauthClientId, '….apps.googleusercontent.com'),
  })}
  ${box({
    key: 'oauthClientSecret',
    label: 'OAuth client secret',
    status: secretStatus(s.oauthClientSecret),
    control: textControl('', s.oauthClientSecret ? 'Enter a new secret to replace the stored one' : 'GOCSPX-…', 'password'),
    extra: clearExtra(!!s.oauthClientSecret),
  })}
  <h3 class="subhead">SAML SSO (Okta, Entra, OneLogin, any IdP)</h3>
  <p class="f-hint" style="margin:.2rem 0 .4rem">Point your IdP's custom SAML app at ACS URL
    <code>https://&lt;your-host&gt;/auth/saml/acs</code> with entity ID
    <code>https://&lt;your-host&gt;/auth/saml/metadata</code> (SP metadata served there).</p>
  ${box({ key: 'samlIdpEntityId', label: 'IdP entity ID', status: chip(!!s.samlIdpEntityId, 'Set', 'Not set'), control: textControl(s.samlIdpEntityId, 'e.g. https://accounts.google.com/o/saml2?idpid=…') })}
  ${box({ key: 'samlIdpSsoUrl', label: 'IdP SSO URL', status: chip(!!s.samlIdpSsoUrl, 'Set', 'Not set'), control: textControl(s.samlIdpSsoUrl, 'https://…/sso/saml') })}
  ${box({
    key: 'samlIdpCert',
    label: 'IdP certificate (X.509 PEM)',
    status: chip(!!s.samlIdpCert, 'Set', 'Not set'),
    control: `<textarea name="value" rows="4" placeholder="-----BEGIN CERTIFICATE-----">${esc(s.samlIdpCert)}</textarea>`,
  })}
  ${box({ key: 'samlAdminAttribute', label: 'Admin attribute', hint: 'Assertion attribute checked for the admin group.', control: textControl(s.samlAdminAttribute, 'groups') })}
  ${box({ key: 'samlAdminGroup', label: 'Admin group value', hint: 'Members get the admin console; Google Directory admins always do.', control: textControl(s.samlAdminGroup, 'asyncup-admins') })}`;

  const tokensSet = [s.tickToken, s.exportToken, s.scimToken].filter(Boolean).length;
  const tokensBody = `${tokenRow('tickToken', 'Scheduler tick token', 'Authorizes POST /tick for external cron (scale-to-zero deploys).')}
    ${tokenRow('exportToken', 'CSV export token', 'Enables GET /export. Endpoint stays off until a token exists.')}
    ${tokenRow('scimToken', 'SCIM provisioning token', 'Bearer token for /scim/v2 (Okta, Entra, OneLogin). Deactivating a user there removes them from every roster.')}`;

  return `
  <div class="kicker">Configuration</div>
  <h1>Settings</h1>
  <p class="muted">Stored in your database; secrets are encrypted with your <code>SECRET_KEY</code>. Each box saves on
  its own; changes apply immediately — no restart. Prefer a guided run-through?
  <a href="/dashboard/setup">Open the setup walkthrough</a>.</p>
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
    status: googleOn || samlOn ? chip(true, [googleOn && 'Google', samlOn && 'SAML'].filter(Boolean).join(' + ') + (s.tokenSignIn ? ' + token' : '')) : chip(s.tokenSignIn, 'Token only', 'Locked'),
    body: signInBody,
  })}
  ${section({ title: 'Access tokens', desc: 'machine endpoints: /tick, /export, /scim', status: chip(tokensSet > 0, `${tokensSet} set`, 'None set'), open: !!revealed, body: tokensBody })}`;
}
