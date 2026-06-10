import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { Repo } from './db/repo.js';
import { FakeAdapter } from './adapters/fake/adapter.js';
import { GoogleChatAdapter } from './adapters/gchat/adapter.js';
import { ChatRequestVerifier } from './adapters/gchat/auth.js';
import { EventRouter } from './adapters/gchat/events.js';
import { CommandHandler } from './core/commands.js';
import { Scheduler } from './core/scheduler.js';
import { StandupService } from './core/standup-service.js';
import { createServer } from './server.js';

const config = loadConfig();

mkdirSync(dirname(config.dbPath), { recursive: true });
const repo = new Repo(config.dbPath);

const adapter =
  config.adapter === 'google'
    ? new GoogleChatAdapter(repo)
    : new FakeAdapter((msg) => console.log(`[fake-adapter] ${msg}`));

const service = new StandupService(repo, adapter);
const commands = new CommandHandler(repo, config.defaultTimezone);
const router = new EventRouter(commands, service, config.tenantId);

let verifier: ChatRequestVerifier | null = null;
if (config.chatAudience) {
  verifier = new ChatRequestVerifier(config.chatAudience);
} else {
  console.warn(
    '[server] GOOGLE_CHAT_AUDIENCE is not set — incoming requests are NOT verified. ' +
      'Set it to your GCP project number before exposing this to the internet.',
  );
}

const scheduler = new Scheduler(repo, adapter, service);
scheduler.start();
scheduler.tick().catch((err) => console.error('[scheduler] initial tick failed:', err));

const app = createServer(router, verifier, scheduler, config.tickToken);
app.listen(config.port, () => {
  console.log(`asyncup listening on :${config.port} (adapter: ${config.adapter}, db: ${config.dbPath})`);
});
