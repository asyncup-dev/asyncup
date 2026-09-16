import { describe, expect, it } from 'bun:test';
import type { OAuth2Client } from 'google-auth-library';
import { ChatRequestVerifier } from '../src/adapters/gchat/auth.js';

const ISSUER = 'chat@system.gserviceaccount.com';

function jwt(payload: object): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'RS256' })}.${seg(payload)}.signature`;
}

function fakeClient(accept: (audience: string) => void | never) {
  const state = { certFetches: 0, verified: [] as [string, Record<string, string>, string][] };
  const client = {
    request: async ({ url }: { url: string }) => {
      expect(url).toBe(`https://www.googleapis.com/service_accounts/v1/metadata/x509/${ISSUER}`);
      state.certFetches += 1;
      return { data: { kid1: 'PEM' } };
    },
    verifySignedJwtWithCertsAsync: async (token: string, certs: Record<string, string>, audience: string, issuers: string[]) => {
      expect(issuers).toEqual([ISSUER]);
      state.verified.push([token, certs, audience]);
      accept(audience);
      return {};
    },
  } as unknown as OAuth2Client;
  return { client, state };
}

describe('ChatRequestVerifier.verify', () => {
  it('fetches the Chat signing certs once and accepts a token for any configured audience', async () => {
    const { client, state } = fakeClient((aud) => {
      if (aud !== 'https://standup.example.com/chat/events') throw new Error('Wrong recipient');
    });
    const v = new ChatRequestVerifier(['742900314218', 'https://standup.example.com/chat/events'], client);
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
    const { client } = fakeClient(() => {
      throw new Error('Token used too late');
    });
    const v = new ChatRequestVerifier('742900314218', client);
    expect(await v.verify(`Bearer ${jwt({ iss: ISSUER, aud: '742900314218' })}`)).toEqual({
      ok: false,
      reason: 'signature or expiry invalid: Token used too late',
      aud: '742900314218',
      iss: ISSUER,
    });
  });

  it('stringifies non-Error rejections', async () => {
    const { client } = fakeClient(() => {
      throw 'boom';
    });
    const v = new ChatRequestVerifier(['742900314218'], client);
    expect(await v.verify(`Bearer ${jwt({ iss: ISSUER, aud: '742900314218' })}`)).toMatchObject({
      ok: false,
      reason: 'signature or expiry invalid: boom',
    });
  });
});
