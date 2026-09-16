import { describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import { PostgresDriver, SqliteDriver, type PgClient } from '../src/db/driver.js';

const URL = 'postgres://u:p@db.example.com:5432/asyncup';

interface Call {
  sql: string;
  params?: unknown[];
}

interface FakeClient {
  calls: Call[];
  connected: boolean;
  ended: boolean;
  connectError?: unknown;
  respond: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
  client: PgClient;
}

function fakeClient(respond: FakeClient['respond'] = async () => ({ rows: [], rowCount: 0 })): FakeClient {
  const fake: FakeClient = {
    calls: [],
    connected: false,
    ended: false,
    respond,
    client: undefined as unknown as PgClient,
  };
  fake.client = {
    async connect() {
      if (fake.connectError) throw fake.connectError;
      fake.connected = true;
    },
    async query(sql: string, params?: unknown[]) {
      fake.calls.push(params === undefined ? { sql } : { sql, params });
      return fake.respond(sql, params);
    },
    async end() {
      fake.ended = true;
    },
  } as unknown as PgClient;
  return fake;
}

async function connect(fake: FakeClient, url = URL, schema?: string) {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    const driver = await PostgresDriver.connect(url, schema, () => fake.client);
    fake.calls.length = 0;
    return { driver, logged: log.mock.calls.map((c) => c[0]) };
  } finally {
    log.mockRestore();
  }
}

describe('PostgresDriver.connect', () => {
  it('hands pg the resolved connection string and ssl option, and bootstraps the migrations table', async () => {
    const configs: pg.ClientConfig[] = [];
    const fake = fakeClient();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const driver = await PostgresDriver.connect(`${URL}?sslmode=require`, undefined, (config) => {
        configs.push(config);
        return fake.client;
      });
      expect(driver.dialect).toBe('postgres');
      expect(configs).toEqual([{ connectionString: URL, ssl: { rejectUnauthorized: false } }]);
      expect(log.mock.calls).toEqual([['[db] postgres TLS: require']]);
    } finally {
      log.mockRestore();
    }
    expect(fake.connected).toBe(true);
    expect(fake.calls).toEqual([{ sql: 'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL)' }]);
  });

  it('creates and selects the schema when one is given', async () => {
    const fake = fakeClient();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await PostgresDriver.connect(URL, 'tenant_a', () => fake.client);
    } finally {
      log.mockRestore();
    }
    expect(fake.calls.map((c) => c.sql)).toEqual([
      'CREATE SCHEMA IF NOT EXISTS tenant_a',
      'SET search_path TO tenant_a',
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL)',
    ]);
  });

  it('refuses a schema name that could not be interpolated safely', async () => {
    const fake = fakeClient();
    await expect(connect(fake, URL, 'drop; --')).rejects.toThrow('invalid schema name: drop; --');
    expect(fake.connected).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it('explains private-CA verification failures instead of surfacing the raw TLS code', async () => {
    for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
      const fake = fakeClient();
      fake.connectError = Object.assign(new Error('tls'), { code });
      const err = await connect(fake).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(`Postgres TLS verification failed (${code})`);
      expect((err as Error).message).toContain('DB_SSL=require');
      expect((err as Error).message).toContain('DB_SSL=verify-full with DB_SSL_CA=');
    }
  });

  it('rethrows other connection failures untouched, including ones without a code', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const fake = fakeClient();
    fake.connectError = refused;
    await expect(connect(fake)).rejects.toBe(refused);

    const bare = fakeClient();
    bare.connectError = 'no code at all';
    await expect(connect(bare)).rejects.toBe('no code at all');
  });

  it('builds a real pg.Client by default', async () => {
    const boom = Object.assign(new Error('tls'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
    const connectSpy = spyOn(pg.Client.prototype as unknown as { connect(): Promise<void> }, 'connect').mockImplementation(
      () => Promise.reject(boom),
    );
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(PostgresDriver.connect(`${URL}?sslmode=verify-full`)).rejects.toThrow(
        'Postgres TLS verification failed (SELF_SIGNED_CERT_IN_CHAIN)',
      );
      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(log.mock.calls).toEqual([['[db] postgres TLS: verify-full']]);
    } finally {
      connectSpy.mockRestore();
      log.mockRestore();
    }
  });
});

describe('PostgresDriver queries', () => {
  it('rewrites ? placeholders to $n and returns rows, first row, change counts and inserted ids', async () => {
    const fake = fakeClient(async (sql) => {
      if (sql.startsWith('SELECT')) return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
      if (sql.startsWith('UPDATE')) return { rows: [], rowCount: 3 };
      if (sql.startsWith('INSERT')) return { rows: [{ id: '42' }], rowCount: 1 };
      return { rows: [], rowCount: null };
    });
    const { driver } = await connect(fake);

    expect(await driver.all('SELECT * FROM t WHERE a = ? AND b = ?', ['x', 'y'])).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await driver.get('SELECT * FROM t WHERE a = ?', ['x'])).toEqual({ id: 1 });
    expect(await driver.run('UPDATE t SET a = ? WHERE b = ?', [1, 2])).toEqual({ changes: 3 });
    expect(await driver.run('DELETE FROM t')).toEqual({ changes: 0 });
    expect(await driver.insert('INSERT INTO t (a) VALUES (?)', ['v'])).toBe(42);
    await driver.exec('CREATE INDEX i ON t (a)');

    expect(fake.calls).toEqual([
      { sql: 'SELECT * FROM t WHERE a = $1 AND b = $2', params: ['x', 'y'] },
      { sql: 'SELECT * FROM t WHERE a = $1', params: ['x'] },
      { sql: 'UPDATE t SET a = $1 WHERE b = $2', params: [1, 2] },
      { sql: 'DELETE FROM t', params: [] },
      { sql: 'INSERT INTO t (a) VALUES ($1) RETURNING id', params: ['v'] },
      { sql: 'CREATE INDEX i ON t (a)' },
    ]);
  });

  it('returns undefined from get when nothing matches', async () => {
    const { driver } = await connect(fakeClient());
    expect(await driver.get('SELECT 1 WHERE false')).toBeUndefined();
  });

  it('stores the schema version in schema_migrations, defaulting to 0 when the table is empty', async () => {
    let versionRows: any[] = [];
    const fake = fakeClient(async (sql) => ({ rows: sql.startsWith('SELECT version') ? versionRows : [], rowCount: 1 }));
    const { driver } = await connect(fake);

    expect(await driver.getVersion()).toBe(0);
    await driver.setVersion(7);
    versionRows = [{ version: 7 }];
    expect(await driver.getVersion()).toBe(7);

    expect(fake.calls).toEqual([
      { sql: 'SELECT version FROM schema_migrations LIMIT 1', params: [] },
      { sql: 'DELETE FROM schema_migrations', params: [] },
      { sql: 'INSERT INTO schema_migrations (version) VALUES ($1)', params: [7] },
      { sql: 'SELECT version FROM schema_migrations LIMIT 1', params: [] },
    ]);
  });

  it('wraps a transaction in BEGIN/COMMIT and rolls back when the body throws', async () => {
    const fake = fakeClient();
    const { driver } = await connect(fake);

    expect(
      await driver.transaction(async () => {
        await driver.run('UPDATE t SET a = ?', [1]);
        return 'done';
      }),
    ).toBe('done');
    await expect(
      driver.transaction(async () => {
        await driver.run('UPDATE t SET a = ?', [2]);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    expect(fake.calls.map((c) => c.sql)).toEqual([
      'BEGIN',
      'UPDATE t SET a = $1',
      'COMMIT',
      'BEGIN',
      'UPDATE t SET a = $1',
      'ROLLBACK',
    ]);
  });

  it('keeps the original error when ROLLBACK itself fails', async () => {
    const fake = fakeClient(async (sql) => {
      if (sql === 'ROLLBACK') throw new Error('connection lost');
      return { rows: [], rowCount: 0 };
    });
    const { driver } = await connect(fake);
    await expect(
      driver.transaction(async () => {
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
  });

  it('serialises operations so a transaction never interleaves with other queries', async () => {
    const fake = fakeClient();
    const { driver } = await connect(fake);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tx = driver.transaction(async () => {
      await gate;
      await driver.run('UPDATE t SET a = ?', [1]);
    });
    const outside = driver.run('DELETE FROM t');
    await Promise.resolve();
    expect(fake.calls.map((c) => c.sql)).toEqual(['BEGIN']);

    release();
    await Promise.all([tx, outside]);
    expect(fake.calls.map((c) => c.sql)).toEqual(['BEGIN', 'UPDATE t SET a = $1', 'COMMIT', 'DELETE FROM t']);
  });

  it('keeps the queue moving after a failed operation', async () => {
    const fake = fakeClient(async (sql) => {
      if (sql.startsWith('BAD')) throw new Error('syntax error');
      return { rows: [{ ok: 1 }], rowCount: 1 };
    });
    const { driver } = await connect(fake);
    const failed = driver.all('BAD SQL');
    const next = driver.get('SELECT 1');
    await expect(failed).rejects.toThrow('syntax error');
    expect(await next).toEqual({ ok: 1 });
  });

  it('closes the underlying client', async () => {
    const fake = fakeClient();
    const { driver } = await connect(fake);
    await driver.close();
    expect(fake.ended).toBe(true);
  });
});

describe('SqliteDriver', () => {
  it('runs statements against an in-memory bun:sqlite database', async () => {
    const driver = new SqliteDriver(':memory:');
    expect(driver.dialect).toBe('sqlite');
    await driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT NOT NULL)');

    expect(await driver.insert('INSERT INTO t (a) VALUES (?)', ['one'])).toBe(1);
    expect(await driver.insert('INSERT INTO t (a) VALUES (?)', ['two'])).toBe(2);
    expect(await driver.all('SELECT a FROM t ORDER BY id')).toEqual([{ a: 'one' }, { a: 'two' }]);
    expect(await driver.get('SELECT a FROM t WHERE id = ?', [2])).toEqual({ a: 'two' });
    expect(await driver.get('SELECT a FROM t WHERE id = ?', [3])).toBeNull();
    expect(await driver.run('UPDATE t SET a = ?', ['same'])).toEqual({ changes: 2 });
    await driver.close();
  });

  it('tracks the schema version with PRAGMA user_version', async () => {
    const driver = new SqliteDriver(':memory:');
    expect(await driver.getVersion()).toBe(0);
    await driver.setVersion(3);
    expect(await driver.getVersion()).toBe(3);
    await driver.close();
  });

  it('rolls a failed transaction back', async () => {
    const driver = new SqliteDriver(':memory:');
    await driver.exec('CREATE TABLE t (a TEXT)');
    await expect(
      driver.transaction(async () => {
        await driver.run('INSERT INTO t (a) VALUES (?)', ['lost']);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await driver.all('SELECT a FROM t')).toEqual([]);

    await driver.transaction(async () => {
      await driver.run('INSERT INTO t (a) VALUES (?)', ['kept']);
    });
    expect(await driver.all('SELECT a FROM t')).toEqual([{ a: 'kept' }]);
    await driver.close();
  });
});
