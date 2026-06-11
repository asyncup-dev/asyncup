import express, { type Express, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { DateTime } from 'luxon';
import type { EventRouter } from './adapters/gchat/events.js';
import type { ChatRequestVerifier } from './adapters/gchat/auth.js';
import type { Scheduler } from './core/scheduler.js';
import type { Repo } from './db/repo.js';
import { buildCsv } from './core/export.js';
import { registerDashboard } from './dashboard/dashboard.js';

export interface ServerDeps {
  router: EventRouter;
  verifier: ChatRequestVerifier | null;
  scheduler: Scheduler;
  repo: Repo;
  tickToken: string;
  /** Empty string disables the /export endpoint. */
  exportToken: string;
  /** Empty string disables the /dashboard pages. */
  dashboardToken: string;
  now?: () => DateTime;
}

function bearerToken(req: Request): string | undefined {
  return req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
}

export function createServer(deps: ServerDeps): Express {
  const { router, verifier, scheduler, repo, tickToken, exportToken } = deps;
  const now = deps.now ?? (() => DateTime.utc());
  const app = express();
  // First reverse-proxy hop is trusted so rate limiting sees real client IPs.
  app.set('trust proxy', 1);
  app.use(express.json());

  // Brute-force protection for every token-checking endpoint.
  const authLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
  app.use(['/dashboard', '/export', '/tick'], authLimiter);

  registerDashboard(app, { repo, token: deps.dashboardToken, now: deps.now });

  app.get('/healthz', async (_req, res) => {
    try {
      await repo.ping();
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false });
    }
  });

  app.post('/chat/events', async (req, res) => {
    if (verifier && !(await verifier.verify(req.header('authorization')))) {
      res.status(401).json({ error: 'unauthorized' });
      return;
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
    if (!exportToken) {
      res.status(404).json({ error: 'export disabled — set EXPORT_TOKEN to enable' });
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
