import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { Repo } from './db/repo.js';
import { FakeAdapter } from './adapters/fake/adapter.js';
import { GoogleChatAdapter } from './adapters/gchat/adapter.js';
import { EventRouter } from './adapters/gchat/events.js';
import { GoogleCalendarOoo } from './integrations/google-calendar.js';
import { GoogleDirectory } from './integrations/google-directory.js';
import { BlockerService } from './core/blocker-service.js';
import { CommandHandler } from './core/commands.js';
import { PollService } from './core/poll-service.js';
import { Scheduler, type SchedulerProviders } from './core/scheduler.js';
import { SettingsService } from './core/settings.js';
import { chatEndpointUrl } from './adapters/gchat/addon.js';
import { StandupService } from './core/standup-service.js';
import { deriveWebhookSecret } from './core/crypto.js';
import { WebhookNotifier } from './core/webhooks.js';
import { createServer } from './server.js';

const config = loadConfig();

let repo: Repo;
if (config.databaseUrl) {
  repo = await Repo.postgres(config.databaseUrl);
  console.log('[db] using PostgreSQL (DATABASE_URL)');
} else {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  repo = await Repo.sqlite(config.dbPath);
  console.log(`[db] using embedded SQLite at ${config.dbPath}`);
}

const settings = new SettingsService(repo, config.secretKey);

const adapter =
  config.adapter === 'google'
    ? new GoogleChatAdapter(repo, settings)
    : new FakeAdapter((msg) => console.log(`[fake-adapter] ${msg}`));

const webhooks = new WebhookNotifier(undefined, undefined, undefined, (standupId) =>
  deriveWebhookSecret(config.secretKey, standupId),
);
const service = new StandupService(repo, adapter, undefined, webhooks);
const blockerService = new BlockerService(repo, adapter);
const pollService = new PollService(repo, adapter);
const commands = new CommandHandler(repo, settings, undefined, blockerService, adapter, pollService);
const router = new EventRouter(commands, service, blockerService, repo, config.tenantId, pollService, async () =>
  chatEndpointUrl((await settings.get()).chatAudience),
);

// Integrations are resolved from settings per use, so settings changes
// apply immediately — no restart.
const providers: SchedulerProviders = {
  ooo: async () => {
    const s = await settings.get();
    if (!s.calendarOoo || !s.serviceAccountJson) return null;
    return new GoogleCalendarOoo(s.serviceAccountJson);
  },
  directory: async () => {
    const s = await settings.get();
    if (!s.workspaceAdminEmail || !s.serviceAccountJson) return null;
    return new GoogleDirectory(s.serviceAccountJson, s.workspaceAdminEmail);
  },
};

const scheduler = new Scheduler(repo, adapter, service, undefined, undefined, providers, webhooks);
commands.attachRunner(scheduler);
const timer = scheduler.start();
scheduler.tick().catch((err) => console.error('[scheduler] initial tick failed:', err));

const app = createServer({
  router,
  scheduler,
  adapter,
  blockers: blockerService,
  service: service,
  repo,
  settings,
  dashboardToken: config.dashboardToken,
  skipVerification: config.adapter === 'fake',
  webhookSecret: (standupId) => deriveWebhookSecret(config.secretKey, standupId),
  secretKey: config.secretKey,
  tenantId: config.tenantId,
  directory: providers.directory,
});
if (config.dashboardToken) console.log('[app] operator token accepted at /app and /api/v1');
else
  console.warn(
    '[app] DASHBOARD_TOKEN is not set — the web app is reachable only via admin sign-in (Google/SAML).',
  );

const server = app.listen(config.port, () => {
  console.log(`asyncup listening on :${config.port} (adapter: ${config.adapter}, db: ${config.databaseUrl ? 'postgres' : config.dbPath})`);
});

function shutdown(signal: string): void {
  console.log(`[server] received ${signal}, shutting down`);
  clearInterval(timer);
  server.close(async () => {
    await repo.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
