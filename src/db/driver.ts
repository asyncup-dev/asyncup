import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';

export type ResolvedSsl = false | { rejectUnauthorized: boolean; ca?: string } | undefined;

export interface SslResolution {
  connectionString: string;
  ssl: ResolvedSsl;
  /** What we settled on, for logging. */
  mode: 'disable' | 'require' | 'verify-full' | 'none';
}

/**
 * Decide the `ssl` option for node-postgres from the connection string and
 * env, instead of letting `pg` interpret `sslmode` itself.
 *
 * Why: recent `pg`/`pg-connection-string` treat `sslmode=require` as
 * **verify-full**, which rejects managed databases (RDS, Cloud SQL, Neon,
 * Supabase) that use a private CA — the app crash-loops with
 * `SELF_SIGNED_CERT_IN_CHAIN` on first boot. Every other Postgres client
 * (libpq, psycopg, JDBC, pgx) treats `require` as "encrypt, don't verify".
 * We restore that behavior as the default and make strict verification an
 * explicit opt-in.
 *
 * Precedence: `DB_SSL` env > the URL's `sslmode` > none.
 *   - `disable`              → no TLS
 *   - `require` / `prefer`   → encrypt, do NOT verify the cert (default for managed PG)
 *   - `verify-ca`/`verify-full` → verify; pass the CA bundle via `DB_SSL_CA`
 */
export function resolvePostgresSsl(url: string, env: NodeJS.ProcessEnv = process.env): SslResolution {
  const parsed = new URL(url);
  const urlMode = parsed.searchParams.get('sslmode');
  // We set `ssl` explicitly, so strip the params pg would otherwise act on.
  for (const param of ['sslmode', 'uselibpqcompat', 'ssl']) parsed.searchParams.delete(param);
  const connectionString = parsed.toString();

  const mode = (env.DB_SSL ?? urlMode ?? '').toLowerCase();
  const caPath = env.DB_SSL_CA;

  if (mode === '') return { connectionString, ssl: undefined, mode: 'none' };
  if (mode === 'disable') return { connectionString, ssl: false, mode: 'disable' };
  if (mode === 'verify-full' || mode === 'verify-ca') {
    const ca = caPath ? readFileSync(caPath, 'utf8') : undefined;
    return { connectionString, ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) }, mode: 'verify-full' };
  }
  // require / prefer / anything else truthy → encrypt without verification
  return { connectionString, ssl: { rejectUnauthorized: false }, mode: 'require' };
}

/**
 * Thin async database abstraction so the Repo works against embedded SQLite
 * (default) or a bring-your-own PostgreSQL (DATABASE_URL). SQL is written
 * with `?` placeholders and 0/1 integer booleans in both dialects.
 *
 * Concurrency model: all operations run through a serializing queue.
 * transaction() holds the queue for its whole body while inner operations
 * bypass it (reentrancy flag), so a BEGIN/COMMIT pair can never interleave
 * with queries from other requests. AsyncUp's traffic is tiny — a single
 * serialized connection is plenty and keeps both dialects identical.
 */
export interface Driver {
  dialect: 'sqlite' | 'postgres';
  all(sql: string, params?: unknown[]): Promise<any[]>;
  get(sql: string, params?: unknown[]): Promise<any | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** INSERT into a table with an `id` column; returns the new id. */
  insert(sql: string, params?: unknown[]): Promise<number>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  getVersion(): Promise<number>;
  setVersion(version: number): Promise<void>;
  close(): Promise<void>;
}

abstract class QueuedDriver {
  private queue: Promise<unknown> = Promise.resolve();
  private inTransaction = false;

  protected dispatch<T>(op: () => Promise<T>): Promise<T> {
    if (this.inTransaction) return op();
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => {});
    return next;
  }

  protected abstract execRaw(sql: string): Promise<void>;

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.dispatch(async () => {
      this.inTransaction = true;
      try {
        await this.execRaw('BEGIN');
        const result = await fn();
        await this.execRaw('COMMIT');
        return result;
      } catch (err) {
        await this.execRaw('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        this.inTransaction = false;
      }
    });
  }
}

export class SqliteDriver extends QueuedDriver implements Driver {
  readonly dialect = 'sqlite' as const;
  private db: Database.Database;

  constructor(dbPath: string) {
    super();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  protected async execRaw(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async all(sql: string, params: unknown[] = []): Promise<any[]> {
    return this.dispatch(async () => this.db.prepare(sql).all(...params));
  }

  async get(sql: string, params: unknown[] = []): Promise<any | undefined> {
    return this.dispatch(async () => this.db.prepare(sql).get(...params));
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return this.dispatch(async () => ({ changes: this.db.prepare(sql).run(...params).changes }));
  }

  async insert(sql: string, params: unknown[] = []): Promise<number> {
    return this.dispatch(async () => Number(this.db.prepare(sql).run(...params).lastInsertRowid));
  }

  async exec(sql: string): Promise<void> {
    await this.dispatch(() => this.execRaw(sql));
  }

  async getVersion(): Promise<number> {
    return this.dispatch(async () => this.db.pragma('user_version', { simple: true }) as number);
  }

  async setVersion(version: number): Promise<void> {
    await this.dispatch(async () => {
      this.db.pragma(`user_version = ${version}`);
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export class PostgresDriver extends QueuedDriver implements Driver {
  readonly dialect = 'postgres' as const;
  private client: pg.Client;

  private constructor(client: pg.Client) {
    super();
    this.client = client;
  }

  /** `schema` isolates installs/tests sharing one database. */
  static async connect(url: string, schema?: string): Promise<PostgresDriver> {
    const { connectionString, ssl, mode } = resolvePostgresSsl(url);
    const client = new pg.Client({ connectionString, ssl });
    console.log(`[db] postgres TLS: ${mode}`);
    try {
      await client.connect();
    } catch (err: any) {
      const code = err?.code ?? '';
      if (code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
        throw new Error(
          `Postgres TLS verification failed (${code}). Your database uses a private CA ` +
            `(common on RDS/Cloud SQL/Neon). Either set DB_SSL=require to encrypt without ` +
            `verifying, or set DB_SSL=verify-full with DB_SSL_CA=/path/to/ca-bundle.pem.`,
        );
      }
      throw err;
    }
    if (schema) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error(`invalid schema name: ${schema}`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
    }
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL)');
    return new PostgresDriver(client);
  }

  protected async execRaw(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async all(sql: string, params: unknown[] = []): Promise<any[]> {
    return this.dispatch(async () => (await this.client.query(toPgPlaceholders(sql), params)).rows);
  }

  async get(sql: string, params: unknown[] = []): Promise<any | undefined> {
    return this.dispatch(async () => (await this.client.query(toPgPlaceholders(sql), params)).rows[0]);
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return this.dispatch(async () => ({
      changes: (await this.client.query(toPgPlaceholders(sql), params)).rowCount ?? 0,
    }));
  }

  async insert(sql: string, params: unknown[] = []): Promise<number> {
    return this.dispatch(async () => {
      const res = await this.client.query(`${toPgPlaceholders(sql)} RETURNING id`, params);
      return Number(res.rows[0].id);
    });
  }

  async exec(sql: string): Promise<void> {
    await this.dispatch(() => this.execRaw(sql));
  }

  async getVersion(): Promise<number> {
    const row = await this.get('SELECT version FROM schema_migrations LIMIT 1');
    return row?.version ?? 0;
  }

  async setVersion(version: number): Promise<void> {
    await this.run('DELETE FROM schema_migrations');
    await this.run('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}
