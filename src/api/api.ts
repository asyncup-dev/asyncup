import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import { DateTime } from 'luxon';
import type { ChatClientFactory } from '../adapters/gchat/adapter.js';
import type { SamlBroker, SamlConfig } from '../auth/saml.js';
import type { ChatAdapter } from '../core/adapter.js';
import type { BlockerService } from '../core/blocker-service.js';
import type { WebhookNotifier } from '../core/webhooks.js';
import type { Scheduler } from '../core/scheduler.js';
import type { SettingsService } from '../core/settings.js';
import type { StandupService } from '../core/standup-service.js';
import type { RosterSync } from '../core/roster-sync.js';
import type { ScheduleService } from '../core/schedule.js';
import type { Repo } from '../db/repo.js';
import { registerBlockerRoutes } from './blockers.js';
import { registerEditRequestRoutes } from './edit-requests.js';
import { registerMcpRoutes } from './mcp.js';
import { registerMemberRoutes } from './member.js';
import { registerScheduleRoutes } from './schedule.js';
import { registerPeopleRoutes } from './people.js';
import { registerRoleRoutes } from './roles.js';
import { registerSettingsRoutes } from './settings.js';
import { registerSpaceRoutes } from './spaces.js';
import { resolvePrincipal } from './principal.js';
import { contractCheck } from './spec/check.js';
import { buildOpenApi } from './spec/openapi.js';
import { apiError, CSRF_HEADER, CSRF_VALUE, meView, principalOf, type ApiContext, type ApiRequest } from './shared.js';
import { registerStandupRoutes } from './standups.js';

export { apiError, CSRF_HEADER, CSRF_VALUE } from './shared.js';

/**
 * JSON API under /api/v1 — the front door the v2 web app uses. Chat commands
 * and the API call the same core functions; this layer only shapes JSON and
 * enforces who may see what.
 */
export interface ApiDeps {
  repo: Repo;
  settings: SettingsService;
  scheduler: Scheduler;
  adapter: ChatAdapter;
  blockers: BlockerService;
  service: StandupService | null;
  schedule?: ScheduleService | null;
  roster?: RosterSync | null;
  webhooks: WebhookNotifier;
  webhookSecret?: ((standupId: number) => string) | null;
  chatClientFactory: ChatClientFactory;
  samlBroker: (config: SamlConfig) => SamlBroker;
  externalFetch: typeof fetch;
  secretKey: string;
  operatorToken: string;
  tenantId: string;
  now?: () => DateTime;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function registerApi(app: Express, deps: ApiDeps): void {
  const ctx: ApiContext = {
    repo: deps.repo,
    settings: deps.settings,
    scheduler: deps.scheduler,
    adapter: deps.adapter,
    blockers: deps.blockers,
    service: deps.service,
    schedule: deps.schedule ?? null,
    roster: deps.roster ?? null,
    webhooks: deps.webhooks,
    webhookSecret: deps.webhookSecret ?? null,
    chatClientFactory: deps.chatClientFactory,
    samlBroker: deps.samlBroker,
    externalFetch: deps.externalFetch,
    now: deps.now ?? (() => DateTime.utc()),
  };
  const api = express.Router();
  if (process.env.ASYNCUP_CONTRACT_CHECK) api.use(contractCheck());

  let openapi: Record<string, unknown> | null = null;
  api.get('/openapi.json', (_req, res) => {
    openapi ??= buildOpenApi();
    res.json(openapi);
  });

  // Public: which sign-in buttons the web app should show. No secrets, no state.
  api.get('/auth/methods', async (_req, res) => {
    const s = await deps.settings.get();
    res.json({
      google: !!(s.oauthClientId && s.oauthClientSecret),
      saml: !!(s.samlIdpEntityId && s.samlIdpSsoUrl && s.samlIdpCert),
      token: s.tokenSignIn && !!deps.operatorToken,
    });
  });

  // Polled by the app every few seconds per open page, so roomier than the
  // credential endpoints' limiter — still a brake on token guessing.
  api.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));

  api.use(async (req, res, next) => {
    const resolved = await resolvePrincipal(req, deps);
    if ('error' in resolved) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      apiError(
        res,
        401,
        resolved.error,
        resolved.error === 'bad_token' ? 'The bearer token is not valid.' : 'Sign in, or send a bearer token.',
      );
      return;
    }
    if (resolved.principal.via === 'session' && !SAFE_METHODS.has(req.method) && req.header(CSRF_HEADER) !== CSRF_VALUE) {
      apiError(res, 403, 'csrf', `Browser requests that change state must send ${CSRF_HEADER}: ${CSRF_VALUE}.`);
      return;
    }
    (req as unknown as ApiRequest).principal = resolved.principal;
    next();
  });

  api.get('/me', (req, res) => {
    const p = principalOf(req);
    res.json(meView(p));
  });

  registerStandupRoutes(api, ctx);
  registerBlockerRoutes(api, ctx);
  registerPeopleRoutes(api, ctx);
  registerMemberRoutes(api, ctx);
  registerScheduleRoutes(api, ctx);
  registerEditRequestRoutes(api, ctx);
  registerSettingsRoutes(api, ctx);
  registerSpaceRoutes(api, ctx);
  registerMcpRoutes(api, ctx);
  registerRoleRoutes(api, ctx);

  api.use((_req, res) => apiError(res, 404, 'not_found', 'No such API route.'));
  app.use('/api/v1', api);
}
