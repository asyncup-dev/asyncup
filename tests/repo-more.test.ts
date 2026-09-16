import { describe, expect, it, spyOn } from 'bun:test';
import { PostgresDriver, type PgClient } from '../src/db/driver.js';
import { Repo } from '../src/db/repo.js';

const URL = 'postgres://u:p@db.example.com:5432/asyncup';

interface Call {
  sql: string;
  params?: unknown[];
}

/** A pg.Client stand-in that keeps schema_migrations in memory and accepts everything else. */
function fakePostgres(initialVersion?: number) {
  const calls: Call[] = [];
  let version = initialVersion;
  let ended = false;
  const client = {
    async connect() {},
    async query(sql: string, params?: unknown[]) {
      calls.push(params === undefined ? { sql } : { sql, params });
      if (sql.startsWith('SELECT version')) {
        return { rows: version === undefined ? [] : [{ version }], rowCount: version === undefined ? 0 : 1 };
      }
      if (sql.startsWith('DELETE FROM schema_migrations')) version = undefined;
      if (sql.startsWith('INSERT INTO schema_migrations')) version = params![0] as number;
      if (sql === 'SELECT 1 AS ok') return { rows: [{ ok: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    async end() {
      ended = true;
    },
  } as unknown as PgClient;
  return { calls, client, version: () => version, ended: () => ended };
}

async function withFakeConnect<T>(client: PgClient, body: () => Promise<T>): Promise<T> {
  const original = PostgresDriver.connect.bind(PostgresDriver);
  const connect = spyOn(PostgresDriver, 'connect').mockImplementation((url, schema) => original(url, schema, () => client));
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    return await body();
  } finally {
    connect.mockRestore();
    log.mockRestore();
  }
}

describe('Repo.postgres', () => {
  it('connects into the schema and applies every migration, one transaction each', async () => {
    const db = fakePostgres();
    const repo = await withFakeConnect(db.client, () => Repo.postgres(URL, 'tenant_a'));

    const sql = db.calls.map((c) => c.sql);
    expect(sql.slice(0, 3)).toEqual([
      'CREATE SCHEMA IF NOT EXISTS tenant_a',
      'SET search_path TO tenant_a',
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL)',
    ]);
    const applied = db.calls.filter((c) => c.sql.startsWith('INSERT INTO schema_migrations')).map((c) => c.params![0]);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied).toEqual(applied.map((_, i) => i + 1));
    expect(sql.filter((s) => s === 'BEGIN')).toHaveLength(applied.length);
    expect(sql.filter((s) => s === 'COMMIT')).toHaveLength(applied.length);
    expect(sql).not.toContain('ROLLBACK');
    expect(sql.some((s) => s.includes('CREATE TABLE standups ('))).toBe(true);
    expect(sql.some((s) => s.includes('GENERATED ALWAYS AS IDENTITY'))).toBe(true);
    expect(db.version()).toBe(applied.length);

    db.calls.length = 0;
    expect(await repo.ping()).toBe(true);
    expect(db.calls).toEqual([{ sql: 'SELECT 1 AS ok', params: [] }]);
    await repo.close();
    expect(db.ended()).toBe(true);
  });

  it('is a no-op on a database that is already at the latest version', async () => {
    const first = fakePostgres();
    await withFakeConnect(first.client, () => Repo.postgres(URL));
    const latest = first.version()!;

    const db = fakePostgres(latest);
    await withFakeConnect(db.client, () => Repo.postgres(URL));
    expect(db.calls.map((c) => c.sql)).toEqual([
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL)',
      'SELECT version FROM schema_migrations LIMIT 1',
    ]);
  });
});
