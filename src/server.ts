import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { DateTime } from 'luxon';
import { errorResponse, type EventRouter } from './adapters/gchat/events.js';
import { fromAddonEvent, isAddonEvent, toAddonResponse } from './adapters/gchat/addon.js';
import { ChatRequestVerifier } from './adapters/gchat/auth.js';
import { tokenEquals } from './core/crypto.js';
import { bearerToken } from './core/http.js';
import { clampExportDays } from './core/validation.js';
import type { SettingsService } from './core/settings.js';
import type { Scheduler } from './core/scheduler.js';
import type { Repo } from './db/repo.js';
import { buildCsv } from './core/export.js';
import { registerAuth, type IdentityBroker } from './auth/google.js';
import { registerSaml, type SamlBroker, type SamlConfig } from './auth/saml.js';
import { registerScim } from './scim/server.js';
import { registerApi } from './api/api.js';
import type { ChatAdapter } from './core/adapter.js';
import type { BlockerService } from './core/blocker-service.js';
import { createChatClient, type ChatClientFactory } from './adapters/gchat/adapter.js';
import { NodeSamlBroker } from './auth/saml.js';
import { LAST_EVENT_KEYS, recordChatEvent } from './core/verify.js';
import { WebhookNotifier } from './core/webhooks.js';
import type { StandupService } from './core/standup-service.js';
import { registerMcp } from './mcp/server.js';
import { APP_VERSION } from './version.js';
import type { UserDirectory } from './core/directory.js';

export interface ServerDeps {
  router: EventRouter;
  scheduler: Scheduler;
  /** The platform adapter and blocker workflow the JSON API drives directly. */
  adapter: ChatAdapter;
  blockers: BlockerService;
  repo: Repo;
  settings: SettingsService;
  /** Operator bearer for the JSON API (DASHBOARD_TOKEN). Empty string disables it. */
  dashboardToken: string;
  /** Skip Chat webhook verification (fake adapter / local development). */
  skipVerification?: boolean;
  /** Per-standup webhook signing secret (shown to admins in the standup's settings). */
  webhookSecret?: (standupId: number) => string;
  /** Signs sessions; empty disables Google sign-in. */
  secretKey?: string;
  /** Tenant every API principal belongs to (single-tenant installs: TENANT_ID). */
  tenantId?: string;
  /** Directory lookups for Workspace roles (admin vs user). */
  directory?: () => Promise<UserDirectory | null>;
  /** Test override for the Google OAuth exchange. */
  identityBroker?: (clientId: string, clientSecret: string) => IdentityBroker;
  /** Test override for the SAML exchange. */
  samlBroker?: (config: SamlConfig) => SamlBroker;
  /** Test override for the Chat API client used by verification calls. */
  chatClientFactory?: ChatClientFactory;
  /** Test override for outbound HTTP (webhook tests, IdP reachability). */
  externalFetch?: typeof fetch;
  /** Needed for the MCP submit_answers tool; without it the tool is not offered. */
  service?: StandupService;
  /** Built web app (web/dist). Defaults to the checked-out path; missing = /app answers 404. */
  webDist?: string;
  now?: () => DateTime;
}

/** Collapse control chars (incl. newlines) and cap length before logging untrusted text — prevents log forging. */
function logSafe(value: unknown): string {
  return String(value).replace(/\p{Cc}/gu, ' ').slice(0, 200);
}

export function createServer(deps: ServerDeps): Express {
  const { router, scheduler, repo, settings } = deps;
  const now = deps.now ?? (() => DateTime.utc());

  // The audience lives in DB settings and can change at runtime.
  let verifierCache: { audience: string; verifier: ChatRequestVerifier } | null = null;
  let warnedUnverified = false;
  const getVerifier = async (): Promise<ChatRequestVerifier | 'unconfigured' | null> => {
    if (deps.skipVerification) return null;
    const { chatAudience } = await settings.get();
    if (!chatAudience) {
      if (!warnedUnverified) {
        warnedUnverified = true;
        console.warn(
          '[server] Chat events cannot be verified until the GCP project number is set in Settings › Google Chat — refusing to process them.',
        );
      }
      return 'unconfigured';
    }
    if (verifierCache?.audience !== chatAudience) {
      // chatAudience may hold several space/comma-separated values (project
      // number and/or app URL) — accept a token matching any of them.
      const audiences = chatAudience.split(/[\s,]+/).filter(Boolean);
      verifierCache = { audience: chatAudience, verifier: new ChatRequestVerifier(audiences) };
    }
    return verifierCache.verifier;
  };
  const app = express();
  // First reverse-proxy hop is trusted so rate limiting sees real client IPs.
  app.set('trust proxy', 1);
  app.use(express.json());

  // Brute-force protection for every token-checking endpoint.
  const authLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
  // Every surface that checks a credential gets brute-force protection.
  app.use(['/export', '/tick', '/auth', '/scim', '/mcp'], authLimiter);

  app.use('/auth', express.urlencoded({ extended: false }));
  registerAuth(app, {
    settings,
    secretKey: deps.secretKey ?? '',
    directory: deps.directory ?? (async () => null),
    broker: deps.identityBroker,
  });
  registerSaml(app, {
    settings,
    secretKey: deps.secretKey ?? '',
    directory: deps.directory ?? (async () => null),
    broker: deps.samlBroker,
  });
  registerScim(app, {
    repo,
    settings,
    directory: deps.directory ?? (async () => null),
    now: deps.now,
  });
  registerApi(app, {
    repo,
    settings,
    scheduler,
    adapter: deps.adapter,
    blockers: deps.blockers,
    service: deps.service ?? null,
    webhooks: new WebhookNotifier(undefined, deps.externalFetch, undefined, deps.webhookSecret),
    chatClientFactory: deps.chatClientFactory ?? createChatClient,
    samlBroker: deps.samlBroker ?? ((config) => new NodeSamlBroker(config)),
    externalFetch: deps.externalFetch ?? fetch,
    secretKey: deps.secretKey ?? '',
    operatorToken: deps.dashboardToken,
    tenantId: deps.tenantId ?? 'default',
    now: deps.now,
  });

  // The root has no page of its own — the web app decides where each
  // person lands (setup, the console or their own page).
  app.get('/', (_req, res) => res.redirect('/app'));

  registerMcp(app, {
    repo,
    settings,
    blockers: deps.blockers,
    service: deps.service ?? null,
    tenantId: deps.tenantId ?? 'default',
    version: APP_VERSION,
    now,
  });

  // The React app. Assets are served as-is; every other /app path gets the
  // SPA's index so client-side routes survive a refresh.
  const webDist = deps.webDist ?? join(import.meta.dirname, '..', 'web', 'dist');
  if (existsSync(join(webDist, 'index.html'))) {
    app.use('/app', express.static(webDist, { index: false, fallthrough: true }));
    app.get(['/app', '/app/{*path}'], (_req, res) => res.sendFile(join(webDist, 'index.html')));
  }

  // Public, secret-free summary of the Chat connection — the docs' verify step.
  app.get('/health/chat', async (_req, res) => {
    const s = await settings.get();
    res.json({
      audience: s.chatAudience ? 'set' : 'unset',
      serviceAccount: s.serviceAccountJson ? 'set' : 'unset',
      lastEventAt: await repo.getSettingValue(LAST_EVENT_KEYS.at),
      lastRejectedAt: await repo.getSettingValue(LAST_EVENT_KEYS.rejectedAt),
    });
  });

  app.get('/healthz', async (_req, res) => {
    try {
      await repo.ping();
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false });
    }
  });

  app.post('/chat/events', async (req, res) => {
    // Apps built as Workspace add-ons get a different envelope both ways.
    const addon = isAddonEvent(req.body);
    const event = addon ? fromAddonEvent(req.body) : req.body;
    const reply = (body: object) => res.json(addon ? toAddonResponse(body, event) : body);
    const eventType = event?.type ?? 'unknown';
    console.log(`[chat] POST /chat/events type=${logSafe(eventType)}${addon ? ' format=add-on' : ''}`);
    const verifier = await getVerifier();
    if (verifier === 'unconfigured') {
      // Fail closed: without an audience, any request could impersonate Chat.
      reply({
        text: '⚠️ AsyncUp is not connected to Google Chat yet — an admin must finish setup in the web app first.',
      });
      return;
    }
    if (verifier) {
      const result = await verifier.verify(req.header('authorization'));
      if (!result.ok) {
        console.warn(`[chat] rejected /chat/events (401) — ${logSafe(result.reason)}`);
        await recordChatEvent(repo, now(), false, result.reason);
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
    }
    // Setup's "waiting for the first event" gate reads this.
    await recordChatEvent(repo, now(), true);
    try {
      reply(await router.handle(event));
    } catch (err) {
      console.error('[server] event handling failed:', err);
      reply(errorResponse(event));
    }
  });

  // For scale-to-zero deployments (Cloud Run + Cloud Scheduler, etc.) where
  // the in-process interval doesn't run while the instance is suspended.
  app.post('/tick', async (req, res) => {
    const { tickToken } = await settings.get();
    if (tickToken && !tokenEquals(bearerToken(req), tickToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    await scheduler.tick();
    res.json({ ok: true });
  });

  // CSV export — disabled until an export token is generated in Settings › API & tokens
  // settings (the data is your team's standup answers; never expose it
  // unauthenticated).
  app.get('/export', async (req, res) => {
    const { exportToken } = await settings.get();
    if (!exportToken) {
      res.status(404).json({ error: 'export disabled — generate an export token in Settings › API & tokens' });
      return;
    }
    if (!tokenEquals(bearerToken(req), exportToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const standup = await findStandup(repo, Number(req.query.standupId));
    if (!standup) {
      res.status(404).json({ error: 'unknown standupId' });
      return;
    }
    const days = clampExportDays(req.query.days, 30);
    const today = now().setZone(standup.timezone);
    const csv = await buildCsv(repo, standup, today.minus({ days }).toISODate()!, today.toISODate()!);
    res
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="standup-${standup.id}-last-${days}d.csv"`)
      .send(csv);
  });

  return app;
}

async function findStandup(repo: Repo, id: number) {
  return Number.isInteger(id) ? repo.getStandupById(id) : null;
}
