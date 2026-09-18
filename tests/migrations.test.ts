import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POSTGRES_MIGRATIONS, Repo, SQLITE_MIGRATIONS } from '../src/db/repo.js';

describe('migration 10 — AI removal', () => {
  it('keeps both dialect arrays aligned', () => {
    expect(SQLITE_MIGRATIONS).toHaveLength(12);
    expect(POSTGRES_MIGRATIONS).toHaveLength(12);
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
    expect((check.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(12);
    check.close();
  });
});

describe('migration 11 — MCP tokens and activity', () => {
  it('creates the two tables in both dialects', () => {
    for (const migrations of [SQLITE_MIGRATIONS, POSTGRES_MIGRATIONS]) {
      expect(migrations[10]).toContain('CREATE TABLE mcp_tokens');
      expect(migrations[10]).toContain('CREATE TABLE mcp_activity');
      expect(migrations[10]).toContain('token_hash TEXT NOT NULL UNIQUE');
    }
    expect(POSTGRES_MIGRATIONS[10]).toContain('GENERATED ALWAYS AS IDENTITY');
    expect(SQLITE_MIGRATIONS[10]).toContain('AUTOINCREMENT');
  });

  it('upgrades a v10 database and keeps its data', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'asyncup-mig-')), 'v10.db');
    const raw = new Database(dbPath);
    for (const migration of SQLITE_MIGRATIONS.slice(0, 10)) raw.exec(migration);
    raw.exec(`
      PRAGMA user_version = 10;
      INSERT INTO standups (tenant_id, space_name, name, timezone) VALUES ('default', 'spaces/x', 'Engineering', 'UTC');
    `);
    raw.close();

    const repo = await Repo.sqlite(dbPath);
    expect((await repo.listStandupsBySpace('default', 'spaces/x'))[0]!.name).toBe('Engineering');
    const id = await repo.createMcpToken({
      tenantId: 'default',
      name: 'laptop',
      kind: 'personal',
      ownerUserName: 'users/1',
      ownerDisplayName: 'Asha',
      ownerAdmin: false,
      scopes: 'read',
      tokenHash: 'h1',
      createdAt: '2026-09-16T00:00:00Z',
      expiresAt: '2026-12-15T00:00:00Z',
    });
    expect((await repo.getMcpTokenByHash('h1'))!.id).toBe(id);
    await repo.close();

    const check = new Database(dbPath, { readonly: true });
    expect((check.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(12);
    check.close();
  });
});

describe('migration 12 — personal schedules', () => {
  it('adds the schedule tables and columns in both dialects', () => {
    for (const migrations of [SQLITE_MIGRATIONS, POSTGRES_MIGRATIONS]) {
      expect(migrations[11]).toContain('ALTER TABLE participants ADD COLUMN working_days TEXT');
      expect(migrations[11]).toContain('ALTER TABLE run_participants ADD COLUMN away_reason TEXT');
      expect(migrations[11]).toContain("ADD COLUMN time_off_policy TEXT NOT NULL DEFAULT 'self'");
      expect(migrations[11]).toContain('CREATE TABLE schedule_overrides');
      expect(migrations[11]).toContain('CREATE TABLE schedule_changes');
      expect(migrations[11]).toContain('UNIQUE (user_name, date)');
    }
  });

  it('upgrades a v11 database, defaulting every standup to self-service and every participant to the standup week', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'asyncup-mig-')), 'v11.db');
    const raw = new Database(dbPath);
    for (const migration of SQLITE_MIGRATIONS.slice(0, 11)) raw.exec(migration);
    raw.exec(`
      PRAGMA user_version = 11;
      INSERT INTO standups (tenant_id, space_name, name, timezone) VALUES ('default', 'spaces/x', 'Engineering', 'UTC');
      INSERT INTO participants (standup_id, user_name, display_name) VALUES (1, 'users/a', 'Asha');
    `);
    raw.close();

    const repo = await Repo.sqlite(dbPath);
    const standup = (await repo.listStandupsBySpace('default', 'spaces/x'))[0]!;
    expect(standup.timeOffPolicy).toBe('self');
    expect((await repo.listParticipants(standup.id))[0]!.workingDays).toBeNull();
    const saved = await repo.upsertOverride({
      userName: 'users/a', displayName: 'Asha', date: '2026-09-19', working: false, reason: 'comp off', status: 'active',
      setByUserName: 'users/a', setByDisplayName: 'Asha', channel: 'chat', at: '2026-09-18T10:00:00Z',
    });
    expect((await repo.getOverride('users/a', '2026-09-19'))!.id).toBe(saved.id);
    await repo.close();

    const check = new Database(dbPath, { readonly: true });
    expect((check.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(12);
    check.close();
  });
});
