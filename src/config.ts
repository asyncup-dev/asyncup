import type { LlmConfig } from './ai/llm.js';

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
  /** Shared secret for GET /export. Empty = export endpoint disabled. */
  exportToken: string;
  /** Shared secret for the web dashboard. Empty = dashboard disabled. */
  dashboardToken: string;
  /** Check participants' Google Calendar for OOO events (needs domain-wide delegation). */
  calendarOoo: boolean;
  /** Bring-your-own-key LLM for AI summaries. Null = AI features off. */
  llm: LlmConfig | null;
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
    exportToken: env.EXPORT_TOKEN ?? '',
    dashboardToken: env.DASHBOARD_TOKEN ?? '',
    calendarOoo: env.GOOGLE_CALENDAR_OOO === 'true',
    llm: loadLlmConfig(env),
  };
}

function loadLlmConfig(env: NodeJS.ProcessEnv): LlmConfig | null {
  const provider = env.LLM_PROVIDER;
  if (!provider) return null;
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new Error(`LLM_PROVIDER must be "anthropic" or "openai", got "${provider}"`);
  }
  if (!env.LLM_API_KEY) throw new Error('LLM_PROVIDER is set but LLM_API_KEY is missing');
  const model = env.LLM_MODEL ?? (provider === 'anthropic' ? 'claude-opus-4-7' : '');
  if (!model) throw new Error('LLM_MODEL is required when LLM_PROVIDER=openai');
  return { provider, apiKey: env.LLM_API_KEY, model };
}
