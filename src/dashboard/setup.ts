import type { Express, Request, Response } from 'express';
import type { AppSettings, SettingsService } from '../core/settings.js';
import { esc, layout } from './chrome.js';
import { applySettings, googleSignInOn, samlSignInOn } from './settings-page.js';

/**
 * First-run walkthrough: sign-in → Google Chat → workspace. Each
 * step is one grouped form (the same applySettings sections the settings
 * page uses per field); Finish marks setupComplete and lands on the home
 * page. Re-runnable any time from Settings.
 */

export interface SetupDeps {
  settings: SettingsService;
  authed: (req: Request, res: Response) => Promise<boolean>;
  /** Whether a DASHBOARD_TOKEN exists in the environment at all. */
  hasToken: boolean;
}

const STEPS = ['Sign-in', 'Google Chat', 'Workspace'];

function stepper(current: number, s: AppSettings): string {
  const done = [
    googleSignInOn(s) || samlSignInOn(s),
    !!(s.chatAudience && s.serviceAccountJson),
    s.defaultTimezone !== 'UTC' || !!s.workspaceAdminEmail,
  ];
  return `<div class="stepper">${STEPS.map(
    (title, i) =>
      `${i ? '<span class="sep">—</span>' : ''}<span class="st${i + 1 === current ? ' cur' : ''}${done[i] ? ' done' : ''}">
        <span class="n">${done[i] ? '✓' : i + 1}</span>${esc(title)}</span>`,
  ).join('')}</div>`;
}

const actions = (step: number, submitLabel: string): string =>
  `<div class="wiz-actions">
    <button class="btn" type="submit">${esc(submitLabel)}</button>
    ${step > 1 ? `<a class="btn ghost" href="/dashboard/setup?step=${step - 1}">← Back</a>` : ''}
    <a class="skip" href="/dashboard/setup?step=${step + 1}">Skip this step</a>
  </div>`;

function signinStep(s: AppSettings, hasToken: boolean): string {
  const googleOn = googleSignInOn(s);
  const samlOn = samlSignInOn(s);
  const tokenToggle =
    googleOn || samlOn
      ? `<form method="post" action="/dashboard/setup" class="field" style="margin-top:.9rem">
          <input type="hidden" name="section" value="field"><input type="hidden" name="key" value="tokenSignIn">
          <input type="hidden" name="step" value="1"><input type="hidden" name="stay" value="1">
          <div class="f-head"><span class="f-label">Token sign-in</span>
            <span class="chip ${s.tokenSignIn ? 'on' : 'off'}">${s.tokenSignIn ? 'On' : 'Off'}</span></div>
          <p class="f-hint">Now that ${googleOn ? 'Google' : 'SAML'} sign-in works you can switch the
          <code>DASHBOARD_TOKEN</code> off. If you ever lose the other method, re-enable it in the database:
          <code>DELETE FROM settings WHERE key='tokenSignIn'</code>.</p>
          <div class="f-row"><label class="inline" style="flex:1;margin:0"><input type="checkbox" name="value" ${s.tokenSignIn ? 'checked' : ''}> Allow the operator token</label>
          <button class="btn save" type="submit">Save</button></div>
        </form>`
      : hasToken
        ? `<p class="f-hint">You signed in with the operator token — that keeps working. Once Google or SAML
           sign-in is configured you can switch the token off here or in Settings.</p>`
        : '';
  return `<h2>How will people sign in?</h2>
  <p class="muted">Workspace admins land in this admin console; everyone else gets their personal
  <code>/me</code> page. Configure one method — or skip and stick with the operator token.</p>
  <details class="sub"${!samlOn ? ' open' : ''}>
    <summary><span class="sum-title">Google sign-in</span><span class="sum-desc">recommended for Google-native orgs</span><span class="sum-status"><span class="chip ${googleOn ? 'on' : 'off'}">${googleOn ? 'Configured' : 'Off'}</span></span></summary>
    <form method="post" action="/dashboard/setup">
      <input type="hidden" name="section" value="oauth"><input type="hidden" name="step" value="1">
      <label>OAuth client ID
        <input class="wide" name="oauthClientId" value="${esc(s.oauthClientId)}" placeholder="….apps.googleusercontent.com">
      </label>
      <label>OAuth client secret
        <input name="oauthClientSecret" type="password" placeholder="${s.oauthClientSecret ? 'Enter a new secret to replace the stored one' : 'GOCSPX-…'}" autocomplete="off">
      </label>
      <small class="muted">Create a <b>Web application</b> OAuth client (GCP → APIs &amp; Services → Credentials) with
      redirect URI <code>https://&lt;your-host&gt;/auth/callback</code>.</small>
      ${actions(1, 'Save & continue')}
    </form>
  </details>
  <details class="sub">
    <summary><span class="sum-title">SAML SSO</span><span class="sum-desc">Okta, Entra, OneLogin, any IdP</span><span class="sum-status"><span class="chip ${samlOn ? 'on' : 'off'}">${samlOn ? 'Configured' : 'Off'}</span></span></summary>
    <form method="post" action="/dashboard/setup">
      <input type="hidden" name="section" value="saml"><input type="hidden" name="step" value="1">
      <label>IdP entity ID <input class="wide" name="samlIdpEntityId" value="${esc(s.samlIdpEntityId)}" placeholder="e.g. https://accounts.google.com/o/saml2?idpid=…"></label>
      <label>IdP SSO URL <input class="wide" name="samlIdpSsoUrl" value="${esc(s.samlIdpSsoUrl)}" placeholder="https://…/sso/saml"></label>
      <label>IdP certificate (X.509 PEM)
        <textarea name="samlIdpCert" rows="4" placeholder="-----BEGIN CERTIFICATE-----">${esc(s.samlIdpCert)}</textarea>
      </label>
      <label>Admin attribute <input name="samlAdminAttribute" value="${esc(s.samlAdminAttribute)}"></label>
      <label>Admin group value <input name="samlAdminGroup" value="${esc(s.samlAdminGroup)}"></label>
      <small class="muted">Point your IdP's custom SAML app at ACS URL <code>https://&lt;your-host&gt;/auth/saml/acs</code>
      with entity ID <code>https://&lt;your-host&gt;/auth/saml/metadata</code>.</small>
      ${actions(1, 'Save & continue')}
    </form>
  </details>
  ${tokenToggle}
  <div class="wiz-actions"><a class="btn ghost" href="/dashboard/setup?step=2">Continue with what's configured →</a></div>`;
}

function chatStep(s: AppSettings): string {
  return `<h2>Connect your Google Workspace</h2>
  <p class="muted">The Chat connection is what makes everything work: it verifies incoming events and lets
  AsyncUp message your team.</p>
  <form method="post" action="/dashboard/setup">
    <input type="hidden" name="section" value="chat"><input type="hidden" name="step" value="2">
    <label>Audience
      <input class="wide" name="chatAudience" value="${esc(s.chatAudience)}" placeholder="GCP project number, e.g. 123456789012">
      <small class="muted">The GCP project <b>number</b> (digits, Cloud overview → Project info) and/or the Chat app
      URL, space-separated — not the project ID slug or org ID.</small>
    </label>
    <label>Service-account key (JSON)
      <textarea name="serviceAccountJson" rows="4" placeholder='${s.serviceAccountJson ? 'Paste a new key to replace the stored one' : '{ "type": "service_account", … } — paste the whole downloaded key file'}'></textarea>
      <small class="muted">${s.serviceAccountJson ? 'A key is already stored — leave empty to keep it.' : 'Empty = Application Default Credentials.'}</small>
    </label>
    ${actions(2, 'Save & continue')}
  </form>`;
}

function workspaceStep(s: AppSettings): string {
  return `<h2>Workspace defaults</h2>
  <form method="post" action="/dashboard/setup">
    <input type="hidden" name="section" value="workspace"><input type="hidden" name="step" value="3">
    <input type="hidden" name="finish" value="1">
    <label>Default timezone for new standups
      <input name="defaultTimezone" value="${esc(s.defaultTimezone)}" placeholder="Asia/Kolkata">
    </label>
    <label class="inline big"><input type="checkbox" name="calendarOoo" ${s.calendarOoo ? 'checked' : ''}>
      Google Calendar OOO sync <small class="muted">auto-mark people away on out-of-office days</small>
    </label>
    <label>Workspace admin email
      <input name="workspaceAdminEmail" value="${esc(s.workspaceAdminEmail)}" placeholder="admin@yourdomain.com (optional)">
      <small class="muted">Enables Directory lookups — emails resolve for everyone and Workspace admins are
      recognised by the consoles. Needs <code>admin.directory.user.readonly</code> in domain-wide delegation.</small>
    </label>
    <p class="f-hint">Access tokens for machine endpoints (<code>/tick</code>, <code>/export</code>, SCIM
    provisioning) live in <a href="/dashboard/settings">Settings → Access tokens</a> when you need them.</p>
    <div class="wiz-actions">
      <button class="btn" type="submit">Save & finish</button>
      <a class="btn ghost" href="/dashboard/setup?step=2">← Back</a>
    </div>
  </form>
  <form method="post" action="/dashboard/setup" style="margin-top:.4rem">
    <input type="hidden" name="action" value="finish">
    <button class="skip" type="submit" style="background:none;border:0;cursor:pointer;font:inherit;color:var(--muted)">Finish without changes</button>
  </form>`;
}

export function registerSetup(app: Express, deps: SetupDeps): void {
  const { settings, authed } = deps;

  const render = async (res: Response, step: number, error: string | null) => {
    const s = await settings.get();
    const bodies = [signinStep(s, deps.hasToken), chatStep(s), workspaceStep(s)];
    res.status(error ? 400 : 200).send(
      layout(
        'Setup — AsyncUp',
        'settings',
        `<div class="kicker">First-run setup</div>
        <h1>Welcome to AsyncUp</h1>
        <p class="muted">A few choices and the standups flow. Everything here can be changed later in
        <a href="/dashboard/settings">Settings</a>.</p>
        ${stepper(step, s)}
        ${error ? `<div class="toast err">⚠ ${esc(error)}</div>` : ''}
        <section class="card">${bodies[step - 1]}</section>`,
      ),
    );
  };

  const stepFrom = (raw: unknown): number => Math.min(STEPS.length, Math.max(1, Number(raw) || 1));

  app.get('/dashboard/setup', async (req, res) => {
    if (!(await authed(req, res))) return;
    await render(res, stepFrom(req.query.step), null);
  });

  app.post('/dashboard/setup', async (req, res) => {
    if (!(await authed(req, res))) return;
    const body = req.body ?? {};
    if (body.action === 'finish') {
      await settings.update({ setupComplete: true });
      res.redirect(303, '/dashboard');
      return;
    }
    const step = stepFrom(body.step);
    const error = await applySettings(settings, body);
    if (error) {
      await render(res, step, error);
      return;
    }
    if (body.finish === '1') {
      await settings.update({ setupComplete: true });
      res.redirect(303, '/dashboard');
      return;
    }
    res.redirect(303, `/dashboard/setup?step=${body.stay === '1' ? step : Math.min(STEPS.length, step + 1)}`);
  });
}
