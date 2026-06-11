import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { Repo } from './db/repo.js';
import { FakeAdapter } from './adapters/fake/adapter.js';
import { GoogleChatAdapter } from './adapters/gchat/adapter.js';
import { EventRouter } from './adapters/gchat/events.js';
import { createLlm } from './ai/llm.js';
import { AiSummarizer } from './ai/summarizer.js';
import { GoogleCalendarOoo } from './integrations/google-calendar.js';
import { BlockerService } from './core/blocker-service.js';
import { CommandHandler } from './core/commands.js';
import { Scheduler, type SchedulerProviders } from './core/scheduler.js';
import { SettingsService } from './core/settings.js';
import { StandupService } from './core/standup-service.js';
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

const service = new StandupService(repo, adapter);
const blockerService = new BlockerService(repo, adapter);
const commands = new CommandHandler(repo, settings, undefined, blockerService);
const router = new EventRouter(commands, service, blockerService, repo, config.tenantId);

// Integrations are resolved from settings per use, so dashboard changes
// apply immediately — no restart.
const providers: SchedulerProviders = {
  summarizer: async () => {
    const s = await settings.get();
    if (!s.llmProvider || !s.llmApiKey) return null;
    const model = s.llmModel || (s.llmProvider === 'anthropic' ? 'claude-opus-4-7' : '');
    if (!model) return null;
    return new AiSummarizer(createLlm({ provider: s.llmProvider, apiKey: s.llmApiKey, model }));
  },
  ooo: async () => {
    const s = await settings.get();
    if (!s.calendarOoo || !s.serviceAccountJson) return null;
    return new GoogleCalendarOoo(s.serviceAccountJson);
  },
};

const scheduler = new Scheduler(repo, adapter, service, undefined, undefined, providers);
const timer = scheduler.start();
scheduler.tick().catch((err) => console.error('[scheduler] initial tick failed:', err));

const app = createServer({
  router,
  scheduler,
  repo,
  settings,
  dashboardToken: config.dashboardToken,
  skipVerification: config.adapter === 'fake',
});
if (config.dashboardToken) console.log('[dashboard] enabled at /dashboard');
else console.warn('[dashboard] DASHBOARD_TOKEN is not set — the dashboard (and all app settings) are unavailable.');

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
