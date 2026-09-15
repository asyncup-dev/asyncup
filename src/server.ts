import express, { type Express, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { DateTime } from 'luxon';
import { errorResponse, type EventRouter } from './adapters/gchat/events.js';
import { ChatRequestVerifier } from './adapters/gchat/auth.js';
import { tokenEquals } from './core/crypto.js';
import type { SettingsService } from './core/settings.js';
import type { Scheduler } from './core/scheduler.js';
import type { Repo } from './db/repo.js';
import { buildCsv } from './core/export.js';
import { registerDashboard } from './dashboard/dashboard.js';
import { registerUserConsole } from './dashboard/me.js';
import { registerAuth, type IdentityBroker } from './auth/google.js';
import type { UserDirectory } from './core/directory.js';

export interface ServerDeps {
  router: EventRouter;
  scheduler: Scheduler;
  repo: Repo;
  settings: SettingsService;
  /** Empty string disables the /dashboard pages. */
  dashboardToken: string;
  /** Skip Chat webhook verification (fake adapter / local development). */
  skipVerification?: boolean;
  /** Per-standup webhook signing secret (shown to admins on the dashboard). */
  webhookSecret?: (standupId: number) => string;
  /** Signs sessions; empty disables Google sign-in. */
  secretKey?: string;
  /** Directory lookups for Workspace roles (admin vs user). */
  directory?: () => Promise<UserDirectory | null>;
  /** Test override for the Google OAuth exchange. */
  identityBroker?: (clientId: string, clientSecret: string) => IdentityBroker;
  now?: () => DateTime;
}

function bearerToken(req: Request): string | undefined {
  return req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
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
          '[server] Chat events cannot be verified until the GCP project number is set in dashboard settings — refusing to process them.',
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
  app.use(['/dashboard', '/export', '/tick'], authLimiter);

  const signInEnabled = async () => {
    const { oauthClientId, oauthClientSecret } = await settings.get();
    return !!(oauthClientId && oauthClientSecret);
  };
  app.use(['/me', '/auth'], express.urlencoded({ extended: false }));
  registerAuth(app, {
    settings,
    secretKey: deps.secretKey ?? '',
    directory: deps.directory ?? (async () => null),
    broker: deps.identityBroker,
  });
  registerUserConsole(app, {
    repo,
    secretKey: deps.secretKey ?? '',
    now: deps.now,
    signInEnabled,
  });
  registerDashboard(app, {
    repo,
    settings,
    token: deps.dashboardToken,
    now: deps.now,
    runNow: (standup) => scheduler.runNow(standup),
    webhookSecret: deps.webhookSecret,
    secretKey: deps.secretKey,
    signInEnabled,
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
    const eventType = req.body?.type ?? 'unknown';
    console.log(`[chat] POST /chat/events type=${logSafe(eventType)}`);
    const verifier = await getVerifier();
    if (verifier === 'unconfigured') {
      // Fail closed: without an audience, any request could impersonate Chat.
      res.json({
        text: '⚠️ AsyncUp is not connected to Google Chat yet — an admin must set the GCP project number in the dashboard settings first.',
      });
      return;
    }
    if (verifier) {
      const result = await verifier.verify(req.header('authorization'));
      if (!result.ok) {
        console.warn(`[chat] rejected /chat/events (401) — ${logSafe(result.reason)}`);
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
    }
    try {
      res.json(await router.handle(req.body));
    } catch (err) {
      console.error('[server] event handling failed:', err);
      res.json(errorResponse(req.body));
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

  // CSV export — disabled until an export token is generated in dashboard
  // settings (the data is your team's standup answers; never expose it
  // unauthenticated).
  app.get('/export', async (req, res) => {
    const { exportToken } = await settings.get();
    if (!exportToken) {
      res.status(404).json({ error: 'export disabled — generate an export token in dashboard settings' });
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
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
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
