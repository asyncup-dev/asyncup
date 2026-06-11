import { DateTime } from 'luxon';
import { SecretBox } from './crypto.js';
import type { Repo } from '../db/repo.js';

/**
 * Runtime app configuration, stored in the database and edited from the
 * dashboard. Secrets are AES-256-GCM encrypted at rest via SECRET_KEY.
 * Only bootstrap values (port, database location, dashboard token, secret
 * key) remain environment variables.
 */
export interface AppSettings {
  /** GCP project number used to verify incoming Chat webhooks. */
  chatAudience: string;
  /** Service-account key JSON (pasted in the UI). Empty = use ADC. */
  serviceAccountJson: string;
  defaultTimezone: string;
  calendarOoo: boolean;
  llmProvider: '' | 'anthropic' | 'openai';
  llmApiKey: string;
  llmModel: string;
  tickToken: string;
  exportToken: string;
}

export const SETTING_DEFAULTS: AppSettings = {
  chatAudience: '',
  serviceAccountJson: '',
  defaultTimezone: 'UTC',
  calendarOoo: false,
  llmProvider: '',
  llmApiKey: '',
  llmModel: '',
  tickToken: '',
  exportToken: '',
};

const SECRET_KEYS: (keyof AppSettings)[] = ['serviceAccountJson', 'llmApiKey', 'tickToken', 'exportToken'];

export class SettingsService {
  private box: SecretBox;
  private cache: AppSettings | null = null;
  private listeners: (() => void)[] = [];

  constructor(
    private repo: Repo,
    secretKey: string,
    private now: () => DateTime = () => DateTime.utc(),
  ) {
    this.box = new SecretBox(secretKey);
  }

  /** Re-create provider clients etc. when settings change. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  async get(): Promise<AppSettings> {
    if (this.cache) return this.cache;
    const settings: AppSettings = { ...SETTING_DEFAULTS };
    for (const row of await this.repo.getSettingRows()) {
      if (!(row.key in settings)) continue;
      let value = row.value;
      if (row.encrypted) {
        try {
          value = this.box.decrypt(row.value);
        } catch {
          // SECRET_KEY changed — treat the secret as unset rather than crash.
          console.error(`[settings] cannot decrypt "${row.key}" — was SECRET_KEY rotated? Re-enter it in the dashboard.`);
          continue;
        }
      }
      const key = row.key as keyof AppSettings;
      (settings as any)[key] = typeof SETTING_DEFAULTS[key] === 'boolean' ? value === 'true' : value;
    }
    this.cache = settings;
    return settings;
  }

  async update(partial: Partial<AppSettings>): Promise<void> {
    const at = this.now().toISO()!;
    for (const [key, raw] of Object.entries(partial)) {
      if (raw === undefined || !(key in SETTING_DEFAULTS)) continue;
      const value = typeof raw === 'boolean' ? String(raw) : raw;
      const secret = SECRET_KEYS.includes(key as keyof AppSettings);
      if (value === '') {
        await this.repo.deleteSetting(key);
      } else {
        await this.repo.setSetting(key, secret ? this.box.encrypt(value) : value, secret, at);
      }
    }
    this.cache = null;
    for (const listener of this.listeners) listener();
  }
}
