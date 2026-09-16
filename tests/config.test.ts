import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('fills every default for a fake-adapter install with nothing set', () => {
    expect(loadConfig({ ADAPTER: 'fake' })).toEqual({
      port: 8080,
      dbPath: './data/standup.db',
      databaseUrl: '',
      adapter: 'fake',
      tenantId: 'default',
      dashboardToken: '',
      secretKey: 'dev-only-ephemeral-secret',
      dbSsl: '',
      dbSslCa: '',
    });
  });

  it('defaults the adapter to google and then insists on SECRET_KEY', () => {
    expect(() => loadConfig({})).toThrow('SECRET_KEY is required');
    expect(loadConfig({ SECRET_KEY: 'k' }).adapter).toBe('google');
  });

  it('treats an empty SECRET_KEY as missing for the google adapter', () => {
    expect(() => loadConfig({ ADAPTER: 'google', SECRET_KEY: '' })).toThrow('openssl rand -hex 32');
  });

  it('rejects any adapter other than google or fake', () => {
    expect(() => loadConfig({ ADAPTER: 'slack' })).toThrow('ADAPTER must be "google" or "fake", got "slack"');
  });

  it('reads every value from the environment', () => {
    expect(
      loadConfig({
        PORT: '9090',
        DB_PATH: '/var/lib/asyncup/standup.db',
        DATABASE_URL: 'postgres://u:p@db/asyncup',
        ADAPTER: 'google',
        TENANT_ID: 'acme',
        DASHBOARD_TOKEN: 'dash',
        SECRET_KEY: 'deadbeef',
        DB_SSL: 'verify-full',
        DB_SSL_CA: '/etc/ssl/ca.pem',
      }),
    ).toEqual({
      port: 9090,
      dbPath: '/var/lib/asyncup/standup.db',
      databaseUrl: 'postgres://u:p@db/asyncup',
      adapter: 'google',
      tenantId: 'acme',
      dashboardToken: 'dash',
      secretKey: 'deadbeef',
      dbSsl: 'verify-full',
      dbSslCa: '/etc/ssl/ca.pem',
    });
  });

  it('keeps an explicit SECRET_KEY for the fake adapter instead of the dev placeholder', () => {
    expect(loadConfig({ ADAPTER: 'fake', SECRET_KEY: 'real' }).secretKey).toBe('real');
  });

  it('falls back to process.env when no environment is passed', () => {
    const saved = { ADAPTER: process.env.ADAPTER, PORT: process.env.PORT, SECRET_KEY: process.env.SECRET_KEY };
    process.env.ADAPTER = 'fake';
    process.env.PORT = '1234';
    delete process.env.SECRET_KEY;
    try {
      const cfg = loadConfig();
      expect(cfg.adapter).toBe('fake');
      expect(cfg.port).toBe(1234);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
