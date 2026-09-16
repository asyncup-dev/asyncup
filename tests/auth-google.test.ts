import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { OAuth2Client } from 'google-auth-library';
import { GoogleIdentityBroker, registerAuth } from '../src/auth/google.js';
import { newSession, openSession, sealSession, SESSION_COOKIE } from '../src/auth/session.js';
import type { SettingsService } from '../src/core/settings.js';

const SECRET = 'google-secret-key';

describe('GoogleIdentityBroker', () => {
  it('builds a Google consent URL carrying the redirect, scopes and state', () => {
    const url = new URL(new GoogleIdentityBroker('client-id', 'client-secret').authUrl('https://app.example/auth/callback', 'st4te'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/auth/callback');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'email', 'profile']);
  });

  function fakeClient(payload: Record<string, unknown>) {
    const calls: Record<string, unknown>[] = [];
    const client = {
      getToken: async (opts: unknown) => {
        calls.push({ getToken: opts });
        return { tokens: { id_token: 'id-token' } };
      },
      verifyIdToken: async (opts: unknown) => {
        calls.push({ verifyIdToken: opts });
        return { getPayload: () => payload };
      },
    } as unknown as OAuth2Client;
    return { client, calls };
  }

  it('exchanges the code for an id token and verifies it against the client id', async () => {
    const { client, calls } = fakeClient({ sub: '42', email: 'alice@example.com', name: 'Alice' });
    const broker = new GoogleIdentityBroker('client-id', 'client-secret', () => client);
    expect(await broker.exchange('c0de', 'https://app.example/auth/callback')).toEqual({
      sub: '42',
      email: 'alice@example.com',
      name: 'Alice',
    });
    expect(calls).toEqual([
      { getToken: { code: 'c0de', redirect_uri: 'https://app.example/auth/callback' } },
      { verifyIdToken: { idToken: 'id-token', audience: 'client-id' } },
    ]);
  });

  it('falls back to the email, then a placeholder, when the profile has no name', async () => {
    const noName = new GoogleIdentityBroker('id', 's', () => fakeClient({ sub: '1', email: 'bob@example.com' }).client);
    expect((await noName.exchange('c', 'r')).name).toBe('bob@example.com');
    const bare = new GoogleIdentityBroker('id', 's', () => fakeClient({ sub: '1' }).client);
    expect(await bare.exchange('c', 'r')).toEqual({ sub: '1', email: '', name: 'Unknown' });
  });
});

describe('auth routes with the real Google broker', () => {
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
  });

  function listen(oauth: { oauthClientId?: string; oauthClientSecret?: string }) {
    const app = express();
    registerAuth(app, {
      settings: { get: async () => oauth } as unknown as SettingsService,
      secretKey: SECRET,
      directory: async () => null,
    });
    const server = app.listen(0);
    close = () => server.close();
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('sends the browser to Google consent with the callback derived from the request host', async () => {
    const url = listen({ oauthClientId: 'client-id', oauthClientSecret: 'client-secret' });
    const res = await fetch(`${url}/auth/google`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const consent = new URL(res.headers.get('location')!);
    expect(consent.hostname).toBe('accounts.google.com');
    expect(consent.searchParams.get('client_id')).toBe('client-id');
    expect(consent.searchParams.get('redirect_uri')).toBe(`${url}/auth/callback`);
    expect(res.headers.get('set-cookie')).toContain(`asyncup_oauth_state=${consent.searchParams.get('state')};`);
  });

  it('logout clears the session cookie and sends the user back to sign-in', async () => {
    const url = listen({});
    const sealed = sealSession(SECRET, newSession({ sub: '42', email: 'a@example.com', name: 'A', admin: false }));
    const res = await fetch(`${url}/auth/logout`, { method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${sealed}` }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/sign-in');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toContain('Max-Age=0');
  });
});

describe('openSession', () => {
  it('rejects a correctly signed token whose payload is not a session', () => {
    const payload = Buffer.from('not json').toString('base64url');
    const sig = createHmac('sha256', `session:${SECRET}`).update(payload).digest('base64url');
    expect(openSession(SECRET, `${payload}.${sig}`)).toBeNull();
    expect(openSession(SECRET, payload)).toBeNull();
  });

  it('accepts a SAML session identified by email alone', () => {
    const sealed = sealSession(SECRET, newSession({ sub: '', email: 'okta@example.com', name: 'Okta', admin: false }));
    expect(openSession(SECRET, sealed)?.email).toBe('okta@example.com');
    expect(openSession(SECRET, sealSession(SECRET, newSession({ sub: '', email: '', name: 'Nobody', admin: false })))).toBeNull();
  });
});
