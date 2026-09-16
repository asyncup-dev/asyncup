import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { newSession, sealSession } from '../src/auth/session.js';
import type { AppSettings } from '../src/core/settings.js';
import { createServer } from '../src/server.js';
import { makeStack, TENANT } from './helpers.js';

const TOKEN = 'dash-secret';
const SECRET = 'settings-page-secret';
const GOOGLE = { oauthClientId: 'x.apps.googleusercontent.com', oauthClientSecret: 'GOCSPX-x' };
const SAML = { samlIdpEntityId: 'https://idp.example', samlIdpSsoUrl: 'https://idp.example/sso', samlIdpCert: 'MIICfake' };
let close: (() => void) | null = null;

async function startServer() {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  const app = createServer({
    router,
    scheduler: stack.scheduler,
    repo: stack.repo,
    settings: stack.settings,
    dashboardToken: TOKEN,
    skipVerification: true,
    secretKey: SECRET,
    now: stack.clock.now,
  });
  const server = app.listen(0);
  close = () => server.close();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dashCookie = `asyncup_dash=${TOKEN}`;
  const adminCookie = `asyncup_sess=${sealSession(SECRET, newSession({ sub: '1', email: 'admin@org.com', name: 'Admin', admin: true }))}`;
  const page = async (cookie = dashCookie) => (await fetch(`${url}/dashboard/settings`, { headers: { cookie } })).text();
  const post = (body: Record<string, string>, cookie = dashCookie) =>
    fetch(`${url}/dashboard/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      redirect: 'manual',
    });
  const field = (key: string, value: string) => post({ section: 'field', key, value });
  return { ...stack, url, page, post, field, adminCookie };
}

afterEach(() => {
  close?.();
  close = null;
});

describe('settings per-field checks', () => {
  it('rejects malformed values and persists well-formed ones', async () => {
    const { field, settings } = await startServer();
    const cases: [keyof AppSettings, string, string, string][] = [
      ['serviceAccountJson', '{"type":"service_account"}', 'missing client_email / private_key', JSON.stringify({ client_email: 'bot@p.iam.gserviceaccount.com', private_key: 'k' })],
      ['serviceAccountJson', 'not json', 'must be valid JSON', JSON.stringify({ client_email: 'bot@p.iam.gserviceaccount.com', private_key: 'k' })],
      ['oauthClientId', 'not-a-client-id', 'does not look like an OAuth client ID', 'x.apps.googleusercontent.com'],
      ['samlIdpSsoUrl', 'http://idp.example/sso', 'must be https://', 'https://idp.example/sso'],
      ['samlIdpCert', '<<not a cert>>', 'PEM (or base64) X.509 certificate', 'MIICfakeCert=='],
      ['workspaceAdminEmail', 'not-an-email', "doesn't look like an email address", 'admin@org.com'],
    ];
    for (const [key, bad, message, good] of cases) {
      const refused = await field(key, bad);
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain(message);
      expect((await field(key, good)).status).toBe(302);
      expect((await settings.get())[key]).toBe(good);
    }
    expect((await field('samlIdpCert', '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----')).status).toBe(302);
  });

  it('accepts the free-text fields and the calendar toggle', async () => {
    const { field, post, settings } = await startServer();
    const values: [keyof AppSettings, string][] = [
      ['samlIdpEntityId', 'https://idp.example'],
      ['samlAdminAttribute', 'groups'],
      ['samlAdminGroup', 'asyncup-admins'],
      ['oauthClientSecret', 'GOCSPX-new'],
    ];
    for (const [key, value] of values) {
      expect((await field(key, value)).status).toBe(302);
      expect((await settings.get())[key]).toBe(value);
    }
    expect((await field('calendarOoo', 'on')).status).toBe(302);
    expect((await settings.get()).calendarOoo).toBe(true);
    expect((await post({ section: 'field', key: 'calendarOoo' })).status).toBe(302);
    expect((await settings.get()).calendarOoo).toBe(false);

    const section = await post({ section: 'nope' });
    expect(section.status).toBe(400);
    expect(await section.text()).toContain('Unknown settings section.');
  });
});

describe('settings grouped forms', () => {
  it('saves the OAuth step and clears the stored secret on request', async () => {
    const { post, settings } = await startServer();
    expect((await post({ section: 'oauth', oauthClientId: 'nope' })).status).toBe(400);

    expect((await post({ section: 'oauth', ...GOOGLE })).status).toBe(302);
    let saved = await settings.get();
    expect(saved.oauthClientId).toBe(GOOGLE.oauthClientId);
    expect(saved.oauthClientSecret).toBe(GOOGLE.oauthClientSecret);

    expect((await post({ section: 'oauth', oauthClientId: GOOGLE.oauthClientId })).status).toBe(302);
    expect((await settings.get()).oauthClientSecret).toBe(GOOGLE.oauthClientSecret);

    expect((await post({ section: 'oauth', oauthClientId: GOOGLE.oauthClientId, clear_oauthClientSecret: 'on' })).status).toBe(302);
    saved = await settings.get();
    expect(saved.oauthClientSecret).toBe('');
  });

  it('saves the SAML step', async () => {
    const { post, settings } = await startServer();
    const bad = await post({ section: 'saml', samlIdpSsoUrl: 'http://idp.example/sso' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('must be https://');
    expect((await post({ section: 'saml', samlIdpSsoUrl: 'https://idp.example/sso', samlIdpCert: '<<nope>>' })).status).toBe(400);

    expect((await post({ section: 'saml', ...SAML, samlAdminAttribute: 'memberOf', samlAdminGroup: 'ops' })).status).toBe(302);
    const saved = await settings.get();
    expect(saved.samlIdpEntityId).toBe(SAML.samlIdpEntityId);
    expect(saved.samlIdpSsoUrl).toBe(SAML.samlIdpSsoUrl);
    expect(saved.samlIdpCert).toBe(SAML.samlIdpCert);
    expect(saved.samlAdminAttribute).toBe('memberOf');
    expect(saved.samlAdminGroup).toBe('ops');
  });

  it('saves the workspace step', async () => {
    const { post, settings } = await startServer();
    const bad = await post({ section: 'workspace', defaultTimezone: 'Europe/Berlin', workspaceAdminEmail: 'nope' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("doesn't look like an email address");

    expect(
      (await post({ section: 'workspace', defaultTimezone: 'Europe/Berlin', calendarOoo: 'on', workspaceAdminEmail: 'admin@org.com' })).status,
    ).toBe(302);
    const saved = await settings.get();
    expect(saved.defaultTimezone).toBe('Europe/Berlin');
    expect(saved.calendarOoo).toBe(true);
    expect(saved.workspaceAdminEmail).toBe('admin@org.com');
  });


  it('refuses any save that would remove the last sign-in method', async () => {
    const { post, settings, adminCookie } = await startServer();
    await settings.update({ ...GOOGLE, tokenSignIn: false });

    const viaField = await post({ section: 'field', key: 'oauthClientId', value: '' }, adminCookie);
    expect(viaField.status).toBe(400);
    expect(await viaField.text()).toContain('remove the last working sign-in method');

    const viaStep = await post({ section: 'oauth', oauthClientId: '', clear_oauthClientSecret: 'on' }, adminCookie);
    expect(viaStep.status).toBe(400);
    expect((await settings.get()).oauthClientId).toBe(GOOGLE.oauthClientId);
  });
});

describe('settings page rendering', () => {
  it('locks the token toggle until another sign-in method works', async () => {
    const { page, settings, adminCookie } = await startServer();
    let html = await page();
    expect(html).toContain('On — required');
    expect(html).not.toContain('Allow the operator token');
    expect(html).toContain('Token only');

    await settings.update(GOOGLE);
    html = await page();
    expect(html).toContain('Allow the operator token');
    expect(html).toContain('Safe to turn off now that Google sign-in works');
    expect(html).toContain('Google + token');

    await settings.update({ oauthClientId: '', oauthClientSecret: '', ...SAML });
    html = await page();
    expect(html).toContain('Safe to turn off now that SAML sign-in works');
    expect(html).toContain('SAML + token');

    await settings.update({ samlIdpEntityId: '', samlIdpSsoUrl: '', samlIdpCert: '', tokenSignIn: false });
    html = await page(adminCookie);
    expect(html).toContain('Locked');
  });

  it('offers to clear generated tokens once one exists', async () => {
    const { page, post } = await startServer();
    let html = await page();
    expect(html).not.toContain('value="clear-export"');

    const generated = await post({ action: 'generate-export' });
    expect(generated.status).toBe(200);
    html = await generated.text();
    expect(html).toContain("New token (copy now — it won't be shown again)");
    expect(html).toContain('value="clear-export"');
    expect(html).toContain('1 set');
  });
});
