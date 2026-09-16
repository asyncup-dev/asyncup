import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POSTGRES_MIGRATIONS, Repo, SQLITE_MIGRATIONS } from '../src/db/repo.js';

describe('migration 10 — AI removal', () => {
  it('keeps both dialect arrays aligned', () => {
    expect(SQLITE_MIGRATIONS).toHaveLength(10);
    expect(POSTGRES_MIGRATIONS).toHaveLength(10);
    for (const migrations of [SQLITE_MIGRATIONS, POSTGRES_MIGRATIONS]) {
      expect(migrations[9]).toContain('DROP COLUMN ai_enabled');
      expect(migrations[9]).toContain("'llmApiKey'");
    }
  });

  it('drops the ai_enabled column and forgets stored LLM settings on a v9 database', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'asyncup-mig-')), 'v9.db');
    const raw = new Database(dbPath);
    for (const migration of SQLITE_MIGRATIONS.slice(0, 9)) raw.exec(migration);
    raw.exec(`
      PRAGMA user_version = 9;
      INSERT INTO standups (tenant_id, space_name, name, timezone, ai_enabled, digest_enabled)
        VALUES ('default', 'spaces/x', 'Engineering', 'UTC', 1, 1);
      INSERT INTO settings (key, value, encrypted, updated_at) VALUES
        ('llmProvider', 'anthropic', 0, '2026-09-01T00:00:00Z'),
        ('llmApiKey', 'enc:sk', 1, '2026-09-01T00:00:00Z'),
        ('llmModel', 'claude-x', 0, '2026-09-01T00:00:00Z'),
        ('defaultTimezone', 'Asia/Kolkata', 0, '2026-09-01T00:00:00Z');
    `);
    raw.close();

    const repo = await Repo.sqlite(dbPath);
    const standup = (await repo.listStandupsBySpace('default', 'spaces/x'))[0]!;
    expect(standup.name).toBe('Engineering');
    expect(standup.digestEnabled).toBe(true);
    expect('aiEnabled' in standup).toBe(false);

    const keys = (await repo.getSettingRows()).map((r) => r.key);
    expect(keys).toEqual(['defaultTimezone']);
    await repo.close();

    const check = new Database(dbPath, { readonly: true });
    const columns = (check.query('PRAGMA table_info(standups)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain('ai_enabled');
    expect(columns).toContain('digest_enabled');
    expect((check.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(10);
    check.close();
  });
});
