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
import type { Repo } from '../db/repo.js';
import { registerBlockerRoutes } from './blockers.js';
import { registerMemberRoutes } from './member.js';
import { registerPeopleRoutes } from './people.js';
import { registerSettingsRoutes } from './settings.js';
import { registerSpaceRoutes } from './spaces.js';
import { resolvePrincipal } from './principal.js';
import { apiError, CSRF_HEADER, CSRF_VALUE, principalOf, type ApiContext, type ApiRequest } from './shared.js';
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
  webhooks: WebhookNotifier;
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
    webhooks: deps.webhooks,
    chatClientFactory: deps.chatClientFactory,
    samlBroker: deps.samlBroker,
    externalFetch: deps.externalFetch,
    now: deps.now ?? (() => DateTime.utc()),
  };
  const api = express.Router();

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
    res.json({ kind: p.kind, via: p.via, tenantId: p.tenantId, user: p.user, managedStandupIds: p.managedStandupIds });
  });

  registerStandupRoutes(api, ctx);
  registerBlockerRoutes(api, ctx);
  registerPeopleRoutes(api, ctx);
  registerMemberRoutes(api, ctx);
  registerSettingsRoutes(api, ctx);
  registerSpaceRoutes(api, ctx);

  api.use((_req, res) => apiError(res, 404, 'not_found', 'No such API route.'));
  app.use('/api/v1', api);
}
