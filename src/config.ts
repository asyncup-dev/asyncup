/**
 * Bootstrap-only configuration. Everything else (Google Chat credentials,
 * AI keys, integrations, access tokens, default timezone) lives in the
 * database and is edited from the dashboard — see src/core/settings.ts.
 */
export interface Config {
  port: number;
  dbPath: string;
  /** PostgreSQL connection string; empty = embedded SQLite at DB_PATH. */
  databaseUrl: string;
  adapter: 'google' | 'fake';
  tenantId: string;
  /** Shared secret for the web dashboard. Empty = dashboard disabled. */
  dashboardToken: string;
  /** Encrypts secrets at rest (AES-256-GCM). Required unless ADAPTER=fake. */
  secretKey: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const adapter = env.ADAPTER ?? 'google';
  if (adapter !== 'google' && adapter !== 'fake') {
    throw new Error(`ADAPTER must be "google" or "fake", got "${adapter}"`);
  }
  const secretKey = env.SECRET_KEY ?? '';
  if (!secretKey && adapter === 'google') {
    throw new Error('SECRET_KEY is required — generate one with `openssl rand -hex 32`');
  }
  return {
    port: Number(env.PORT ?? 8080),
    dbPath: env.DB_PATH ?? './data/standup.db',
    databaseUrl: env.DATABASE_URL ?? '',
    adapter,
    tenantId: env.TENANT_ID ?? 'default',
    dashboardToken: env.DASHBOARD_TOKEN ?? '',
    secretKey: secretKey || 'dev-only-ephemeral-secret',
  };
}
