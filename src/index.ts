import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { Repo } from './db/repo.js';
import { FakeAdapter } from './adapters/fake/adapter.js';
import { GoogleChatAdapter } from './adapters/gchat/adapter.js';
import { ChatRequestVerifier } from './adapters/gchat/auth.js';
import { EventRouter } from './adapters/gchat/events.js';
import { createLlm } from './ai/llm.js';
import { AiSummarizer } from './ai/summarizer.js';
import { GoogleCalendarOoo } from './integrations/google-calendar.js';
import { BlockerService } from './core/blocker-service.js';
import { CommandHandler } from './core/commands.js';
import { Scheduler } from './core/scheduler.js';
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

const adapter =
  config.adapter === 'google'
    ? new GoogleChatAdapter(repo)
    : new FakeAdapter((msg) => console.log(`[fake-adapter] ${msg}`));

const service = new StandupService(repo, adapter);
const blockerService = new BlockerService(repo, adapter);
const commands = new CommandHandler(repo, config.defaultTimezone, undefined, blockerService);
const router = new EventRouter(commands, service, blockerService, repo, config.tenantId);

let verifier: ChatRequestVerifier | null = null;
if (config.chatAudience) {
  verifier = new ChatRequestVerifier(config.chatAudience);
} else {
  console.warn(
    '[server] GOOGLE_CHAT_AUDIENCE is not set — incoming requests are NOT verified. ' +
      'Set it to your GCP project number before exposing this to the internet.',
  );
}

let summarizer: AiSummarizer | null = null;
if (config.llm) {
  summarizer = new AiSummarizer(createLlm(config.llm));
  console.log(`[ai] summaries available via ${config.llm.provider} (${config.llm.model})`);
}

let oooChecker: GoogleCalendarOoo | null = null;
if (config.calendarOoo) {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) {
    console.error('[ooo] GOOGLE_CALENDAR_OOO=true requires GOOGLE_APPLICATION_CREDENTIALS');
  } else {
    oooChecker = new GoogleCalendarOoo(keyPath);
    console.log('[ooo] Google Calendar OOO sync enabled');
  }
}

const scheduler = new Scheduler(repo, adapter, service, undefined, undefined, summarizer, oooChecker);
const timer = scheduler.start();
scheduler.tick().catch((err) => console.error('[scheduler] initial tick failed:', err));

const app = createServer({
  router,
  verifier,
  scheduler,
  repo,
  tickToken: config.tickToken,
  exportToken: config.exportToken,
  dashboardToken: config.dashboardToken,
});
if (config.dashboardToken) console.log('[dashboard] enabled at /dashboard');
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
