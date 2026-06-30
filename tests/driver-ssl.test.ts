import { describe, expect, it } from 'vitest';
import { resolvePostgresSsl } from '../src/db/driver.js';

const URL = 'postgres://u:p@db.example.com:5432/asyncup';

describe('resolvePostgresSsl', () => {
  it('defaults to no TLS when nothing is specified (local Postgres)', () => {
    const r = resolvePostgresSsl(URL, {});
    expect(r.ssl).toBeUndefined();
    expect(r.mode).toBe('none');
  });

  it('treats sslmode=require as encrypt-without-verify (libpq semantics, fixes RDS crash-loop)', () => {
    const r = resolvePostgresSsl(`${URL}?sslmode=require`, {});
    expect(r.ssl).toEqual({ rejectUnauthorized: false });
    expect(r.mode).toBe('require');
  });

  it('strips sslmode/uselibpqcompat from the connection string it passes to pg', () => {
    const r = resolvePostgresSsl(`${URL}?sslmode=require&uselibpqcompat=true`, {});
    expect(r.connectionString).not.toContain('sslmode');
    expect(r.connectionString).not.toContain('uselibpqcompat');
    expect(r.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('DB_SSL env overrides the URL', () => {
    expect(resolvePostgresSsl(`${URL}?sslmode=require`, { DB_SSL: 'disable' }).ssl).toBe(false);
    expect(resolvePostgresSsl(URL, { DB_SSL: 'require' }).ssl).toEqual({ rejectUnauthorized: false });
  });

  it('verify-full verifies the cert and loads the CA bundle when given', () => {
    const noCa = resolvePostgresSsl(`${URL}?sslmode=verify-full`, {});
    expect(noCa.ssl).toEqual({ rejectUnauthorized: true });
    expect(noCa.mode).toBe('verify-full');

    // a readable file works as the CA path; we just assert it's wired through
    const withCa = resolvePostgresSsl(URL, { DB_SSL: 'verify-full', DB_SSL_CA: 'package.json' });
    expect(withCa.ssl).toMatchObject({ rejectUnauthorized: true });
    expect((withCa.ssl as { ca?: string }).ca).toContain('asyncup');
  });

  it('disable means no TLS', () => {
    expect(resolvePostgresSsl(`${URL}?sslmode=disable`, {}).ssl).toBe(false);
  });
});
