export interface Config {
  port: number;
  dbPath: string;
  adapter: 'google' | 'fake';
  /** GCP project number used to verify incoming Chat requests. Empty = skip (dev only). */
  chatAudience: string;
  defaultTimezone: string;
  tenantId: string;
  /** Shared secret for POST /tick (external cron on scale-to-zero deploys). Empty = no auth required. */
  tickToken: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const adapter = env.ADAPTER ?? 'google';
  if (adapter !== 'google' && adapter !== 'fake') {
    throw new Error(`ADAPTER must be "google" or "fake", got "${adapter}"`);
  }
  return {
    port: Number(env.PORT ?? 8080),
    dbPath: env.DB_PATH ?? './data/standup.db',
    adapter,
    chatAudience: env.GOOGLE_CHAT_AUDIENCE ?? '',
    defaultTimezone: env.DEFAULT_TIMEZONE ?? 'UTC',
    tenantId: env.TENANT_ID ?? 'default',
    tickToken: env.TICK_TOKEN ?? '',
  };
}
