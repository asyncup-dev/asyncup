import express, { type Express, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { DateTime } from 'luxon';
import type { EventRouter } from './adapters/gchat/events.js';
import { ChatRequestVerifier } from './adapters/gchat/auth.js';
import type { SettingsService } from './core/settings.js';
import type { Scheduler } from './core/scheduler.js';
import type { Repo } from './db/repo.js';
import { buildCsv } from './core/export.js';
import { registerDashboard } from './dashboard/dashboard.js';

export interface ServerDeps {
  router: EventRouter;
  scheduler: Scheduler;
  repo: Repo;
  settings: SettingsService;
  /** Empty string disables the /dashboard pages. */
  dashboardToken: string;
  /** Skip Chat webhook verification (fake adapter / local development). */
  skipVerification?: boolean;
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
  const getVerifier = async (): Promise<ChatRequestVerifier | null> => {
    if (deps.skipVerification) return null;
    const { chatAudience } = await settings.get();
    if (!chatAudience) {
      if (!warnedUnverified) {
        warnedUnverified = true;
        console.warn(
          '[server] Chat webhook verification is OFF — set the GCP project number in dashboard settings.',
        );
      }
      return null;
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

  registerDashboard(app, { repo, settings, token: deps.dashboardToken, now: deps.now });

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
      res.json({ text: '⚠️ Something went wrong handling that — please try again.' });
    }
  });

  // For scale-to-zero deployments (Cloud Run + Cloud Scheduler, etc.) where
  // the in-process interval doesn't run while the instance is suspended.
  app.post('/tick', async (req, res) => {
    const { tickToken } = await settings.get();
    if (tickToken && bearerToken(req) !== tickToken) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    await scheduler.tick();
    res.json({ ok: true });
  });

  // CSV export — disabled unless EXPORT_TOKEN is configured (the data is
  // your team's standup answers; never expose it unauthenticated).
  app.get('/export', async (req, res) => {
    const { exportToken } = await settings.get();
    if (!exportToken) {
      res.status(404).json({ error: 'export disabled — generate an export token in dashboard settings' });
      return;
    }
    if (bearerToken(req) !== exportToken) {
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
