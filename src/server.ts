import express, { type Express } from 'express';
import type { EventRouter } from './adapters/gchat/events.js';
import type { ChatRequestVerifier } from './adapters/gchat/auth.js';
import type { Scheduler } from './core/scheduler.js';

export function createServer(
  router: EventRouter,
  verifier: ChatRequestVerifier | null,
  scheduler: Scheduler,
  tickToken: string,
): Express {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // For scale-to-zero deployments (Cloud Run + Cloud Scheduler, etc.) where
  // the in-process interval doesn't run while the instance is suspended.
  app.post('/tick', async (req, res) => {
    if (tickToken && req.header('authorization') !== `Bearer ${tickToken}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    await scheduler.tick();
    res.json({ ok: true });
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

  return app;
}
