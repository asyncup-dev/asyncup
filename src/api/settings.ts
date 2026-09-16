import type { Request, Response, Router } from 'express';
import { MCP_SCOPE_HELP, parseScopes } from '../core/mcp-scopes.js';
import { googleSignInOn, LOCKOUT_MSG, locksOut, samlSignInOn, stageFieldValue } from '../core/settings-rules.js';
import type { AppSettings } from '../core/settings.js';
import { generateToken } from '../core/crypto.js';
import { verifyChatEvent, verifyDm, verifyProject, verifySaml, verifyServiceAccount, verifyWebhook } from '../core/verify.js';
import { apiError, loadStandup, principalOf, type ApiContext } from './shared.js';

const TOKENS = { tick: 'tickToken', export: 'exportToken', scim: 'scimToken' } as const;

/** Email and numeric client ID from the key, the latter being what domain-wide delegation asks for. */
function saIdentity(json: string): { email: string | null; clientId: string | null } {
  if (!json) return { email: null, clientId: null };
  try {
    const parsed = JSON.parse(json);
    return { email: parsed.client_email ?? null, clientId: parsed.client_id ?? null };
  } catch {
    return { email: null, clientId: null };
  }
}

/** Settings as the admin console shows them — secrets are never echoed, only their presence. */
function view(s: AppSettings) {
  return {
    chat: { audience: s.chatAudience, serviceAccount: { set: !!s.serviceAccountJson, ...saIdentity(s.serviceAccountJson) } },
    workspace: { defaultTimezone: s.defaultTimezone, calendarOoo: s.calendarOoo, workspaceAdminEmail: s.workspaceAdminEmail },
    signIn: {
      tokenSignIn: s.tokenSignIn,
      google: { clientId: s.oauthClientId, clientSecret: { set: !!s.oauthClientSecret }, on: googleSignInOn(s) },
      saml: {
        entityId: s.samlIdpEntityId,
        ssoUrl: s.samlIdpSsoUrl,
        cert: { set: !!s.samlIdpCert },
        adminAttribute: s.samlAdminAttribute,
        adminGroup: s.samlAdminGroup,
        on: samlSignInOn(s),
      },
    },
    tokens: { tick: { set: !!s.tickToken }, export: { set: !!s.exportToken }, scim: { set: !!s.scimToken } },
    setup: { complete: s.setupComplete, chatConfigured: !!(s.chatAudience && s.serviceAccountJson), signInConfigured: googleSignInOn(s) || samlSignInOn(s) },
    mcp: { enabled: s.mcpEnabled, defaultScopes: parseScopes(s.mcpDefaultScopes), endpoint: '/mcp', scopes: MCP_SCOPE_HELP },
  };
}

export function registerSettingsRoutes(api: Router, ctx: ApiContext): void {
  const { repo, settings } = ctx;

  const adminOnly = (req: Request<any>, res: Response): boolean => {
    if (principalOf(req).kind === 'admin') return true;
    apiError(res, 403, 'forbidden', 'Only admins can change workspace settings.');
    return false;
  };

  api.get('/settings', async (req, res) => {
    if (!adminOnly(req, res)) return;
    res.json(view(await settings.get()));
  });

  // Body: { key: value, … }. Strings set, null clears a secret, booleans for toggles.
  api.patch('/settings', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const s = await settings.get();
    const body: Record<string, unknown> = req.body && typeof req.body === 'object' ? req.body : {};
    const change: Partial<AppSettings> = {};
    for (const [key, raw] of Object.entries(body)) {
      const staged = stageFieldValue(s, key, raw);
      if (!staged.ok) {
        apiError(res, 400, 'invalid', staged.message, key);
        return;
      }
      Object.assign(change, staged.change);
    }
    if (locksOut(s, change)) {
      apiError(res, 409, 'lockout', LOCKOUT_MSG);
      return;
    }
    if (Object.keys(change).length) await settings.update(change);
    res.json(view(await settings.get()));
  });

  // Machine tokens are shown once, at generation.
  api.post('/settings/tokens/:name', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const field = TOKENS[String(req.params.name) as keyof typeof TOKENS];
    if (!field) {
      apiError(res, 404, 'not_found', 'Token must be tick, export or scim.');
      return;
    }
    const token = generateToken();
    await settings.update({ [field]: token });
    res.status(201).json({ name: req.params.name, token });
  });

  api.delete('/settings/tokens/:name', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const field = TOKENS[String(req.params.name) as keyof typeof TOKENS];
    if (!field) {
      apiError(res, 404, 'not_found', 'Token must be tick, export or scim.');
      return;
    }
    await settings.update({ [field]: '' });
    res.status(204).end();
  });

  // --- verification gates ---

  api.post('/verify/project', async (req, res) => {
    if (!adminOnly(req, res)) return;
    res.json(verifyProject(await settings.get(), ctx.now()));
  });

  api.post('/verify/service-account', async (req, res) => {
    if (!adminOnly(req, res)) return;
    res.json(await verifyServiceAccount(await settings.get(), ctx.chatClientFactory, ctx.now()));
  });

  api.post('/verify/chat-event', async (req, res) => {
    if (!adminOnly(req, res)) return;
    res.json(await verifyChatEvent(repo, ctx.now()));
  });

  api.post('/verify/webhook', async (req, res) => {
    const id = Number(req.body?.standupId);
    (req.params as Record<string, string>).id = String(id);
    const standup = await loadStandup(ctx, req, res, { manage: true });
    if (!standup) return;
    res.json(await verifyWebhook(standup, ctx.webhooks, ctx.now()));
  });

  api.post('/verify/saml', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json(await verifySaml(await settings.get(), baseUrl, (config) => ctx.samlBroker(config).loginUrl('verify'), ctx.externalFetch, ctx.now()));
  });

  api.post('/verify/dm', async (req, res) => {
    const userName = principalOf(req).user?.userName;
    if (!userName) {
      apiError(res, 403, 'needs_user', 'The test message goes to the signed-in person — the operator token has no Chat identity.');
      return;
    }
    res.json(await verifyDm(ctx.adapter, userName, ctx.now()));
  });
}
