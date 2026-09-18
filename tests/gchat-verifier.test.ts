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
