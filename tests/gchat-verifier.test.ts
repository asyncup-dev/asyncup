import { describe, expect, it } from 'bun:test';
import type { OAuth2Client } from 'google-auth-library';
import { ChatRequestVerifier, fetchChatCerts } from '../src/adapters/gchat/auth.js';

const ISSUER = 'chat@system.gserviceaccount.com';

function jwt(payload: object): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'RS256' })}.${seg(payload)}.signature`;
}

function fakeClient(accept: (audience: string) => void | never) {
  const state = { certFetches: 0, verified: [] as [string, Record<string, string>, string][] };
  const fetchCerts = async (url: string) => {
    expect(url).toBe(`https://www.googleapis.com/service_accounts/v1/metadata/x509/${ISSUER}`);
    state.certFetches += 1;
    return { kid1: 'PEM' };
  };
  const client = {
    verifySignedJwtWithCertsAsync: async (token: string, certs: Record<string, string>, audience: string, issuers: string[]) => {
      expect(issuers).toEqual([ISSUER]);
      state.verified.push([token, certs, audience]);
      accept(audience);
      return {};
    },
  } as unknown as OAuth2Client;
  return { client, fetchCerts, state };
}

describe('ChatRequestVerifier.verify', () => {
  it('fetches the Chat signing certs once and accepts a token for any configured audience', async () => {
    const { client, fetchCerts, state } = fakeClient((aud) => {
      if (aud !== 'https://standup.example.com/chat/events') throw new Error('Wrong recipient');
    });
    const v = new ChatRequestVerifier(['742900314218', 'https://standup.example.com/chat/events'], client, fetchCerts);
    const token = jwt({ iss: ISSUER, aud: 'https://standup.example.com/chat/events' });

    expect(await v.verify(`Bearer ${token}`)).toEqual({ ok: true, aud: 'https://standup.example.com/chat/events' });
    expect(state.verified.map(([, certs, aud]) => [certs, aud])).toEqual([
      [{ kid1: 'PEM' }, '742900314218'],
      [{ kid1: 'PEM' }, 'https://standup.example.com/chat/events'],
    ]);

    expect((await v.verify(`Bearer ${token}`)).ok).toBe(true);
    expect(state.certFetches).toBe(1);
  });

  it('explains a rejection using the last verification error', async () => {
    const { client, fetchCerts } = fakeClient(() => {
      throw new Error('Token used too late');
    });
    const v = new ChatRequestVerifier('742900314218', client, fetchCerts);
    expect(await v.verify(`Bearer ${jwt({ iss: ISSUER, aud: '742900314218' })}`)).toEqual({
      ok: false,
      reason: 'signature or expiry invalid: Token used too late',
      aud: '742900314218',
      iss: ISSUER,
    });
  });

  it('stringifies non-Error rejections', async () => {
    const { client, fetchCerts } = fakeClient(() => {
      throw 'boom';
    });
    const v = new ChatRequestVerifier(['742900314218'], client, fetchCerts);
    expect(await v.verify(`Bearer ${jwt({ iss: ISSUER, aud: '742900314218' })}`)).toMatchObject({
      ok: false,
      reason: 'signature or expiry invalid: boom',
    });
  });
});

describe('fetchChatCerts', () => {
  it('reads the public x509 metadata without any Google credential, and fails loudly on a bad status', async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    try {
      globalThis.fetch = (async (url: string | URL | Request) => {
        calls.push(String(url));
        return calls.length === 1 ? Response.json({ kid1: 'PEM' }) : new Response('nope', { status: 503 });
      }) as typeof fetch;
      expect(await fetchChatCerts()).toEqual({ kid1: 'PEM' });
      expect(calls).toEqual([`https://www.googleapis.com/service_accounts/v1/metadata/x509/${ISSUER}`]);
      await expect(fetchChatCerts()).rejects.toThrow('fetching Chat signing certs failed: HTTP 503');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('ChatRequestVerifier.verify — Workspace add-on tokens', () => {
  const AUDIENCES = ['742900314218', 'https://standup.example.com/chat/events'];
  const SA = 'service-742900314218@gcp-sa-gsuiteaddons.iam.gserviceaccount.com';
  function addonClient(payload: Record<string, unknown> | Error) {
    const calls: unknown[] = [];
    const client = {
      verifyIdToken: async (opts: unknown) => {
        calls.push(opts);
        if (payload instanceof Error || typeof payload === 'string') throw payload;
        return { getPayload: () => payload };
      },
    } as unknown as OAuth2Client;
    return { client, calls };
  }
  const token = (iss: string) => jwt({ iss, aud: 'https://standup.example.com/chat/events' });

  it('verifies a Google-issued token against the URL audiences and the add-on service account', async () => {
    const { client, calls } = addonClient({ email: SA, email_verified: true });
    const v = new ChatRequestVerifier(AUDIENCES, client, async () => ({}));
    expect(await v.verify(`Bearer ${token('https://accounts.google.com')}`)).toEqual({ ok: true, aud: 'https://standup.example.com/chat/events' });
    expect(calls).toEqual([{ idToken: token('https://accounts.google.com'), audience: ['https://standup.example.com/chat/events'] }]);
    expect((await v.verify(`Bearer ${token('accounts.google.com')}`)).ok).toBe(true);
  });

  it('rejects another project\'s add-on, or an unverified email', async () => {
    const other = addonClient({ email: 'service-1@gcp-sa-gsuiteaddons.iam.gserviceaccount.com', email_verified: true });
    expect(await new ChatRequestVerifier(AUDIENCES, other.client, async () => ({})).verify(`Bearer ${token('accounts.google.com')}`)).toEqual({
      ok: false,
      reason: `add-on service account mismatch: token email="service-1@gcp-sa-gsuiteaddons.iam.gserviceaccount.com", expected ${SA}`,
      aud: 'https://standup.example.com/chat/events',
      iss: 'accounts.google.com',
    });
    const unverified = addonClient({ email: SA, email_verified: false });
    expect((await new ChatRequestVerifier(AUDIENCES, unverified.client, async () => ({})).verify(`Bearer ${token('accounts.google.com')}`)).ok).toBe(false);
    const empty = addonClient({});
    expect(await new ChatRequestVerifier(AUDIENCES, empty.client, async () => ({})).verify(`Bearer ${token('accounts.google.com')}`)).toMatchObject({
      reason: expect.stringContaining('token email=""'),
    });
  });

  it('explains what the audience list is missing', async () => {
    const { client } = addonClient({ email: SA, email_verified: true });
    const reason = 'add-on tokens need both the project number and the /chat/events URL in the audience list';
    expect(await new ChatRequestVerifier(['742900314218'], client, async () => ({})).verify(`Bearer ${token('accounts.google.com')}`)).toMatchObject({ ok: false, reason });
    expect(await new ChatRequestVerifier(['https://standup.example.com/chat/events'], client, async () => ({})).verify(`Bearer ${token('accounts.google.com')}`)).toMatchObject({ ok: false, reason });
  });

  it('surfaces signature and expiry failures from the Google verifier', async () => {
    const { client } = addonClient(new Error('Token used too late'));
    expect(await new ChatRequestVerifier(AUDIENCES, client, async () => ({})).verify(`Bearer ${token('accounts.google.com')}`)).toEqual({
      ok: false,
      reason: 'signature or expiry invalid: Token used too late',
      aud: 'https://standup.example.com/chat/events',
      iss: 'accounts.google.com',
    });
    const odd = addonClient('boom' as unknown as Error);
    expect(await new ChatRequestVerifier(AUDIENCES, odd.client, async () => ({})).verify(`Bearer ${token('accounts.google.com')}`)).toMatchObject({
      ok: false,
      reason: 'signature or expiry invalid: boom',
    });
  });
});
