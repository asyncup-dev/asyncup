import { describe, expect, it } from 'vitest';
import { ChatRequestVerifier, classifyFailure, decodeClaims } from '../src/adapters/gchat/auth.js';

function jwt(payload: object): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'RS256' })}.${seg(payload)}.signature`;
}

describe('decodeClaims', () => {
  it('extracts iss/aud without verifying', () => {
    const token = jwt({ iss: 'chat@system.gserviceaccount.com', aud: '819177304171' });
    expect(decodeClaims(token)).toEqual({ iss: 'chat@system.gserviceaccount.com', aud: '819177304171' });
  });

  it('joins array audiences and tolerates garbage', () => {
    expect(decodeClaims(jwt({ aud: ['a', 'b'] })).aud).toBe('a,b');
    expect(decodeClaims('not.a.jwt')).toEqual({});
  });
});

describe('classifyFailure', () => {
  it('names an audience mismatch with the actual vs expected values', () => {
    const r = classifyFailure({ aud: 'https://standup.example.com/chat/events', iss: 'chat@system.gserviceaccount.com' }, ['819177304171'], 'Wrong recipient');
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining('aud mismatch') });
    expect((r as { reason: string }).reason).toContain('819177304171');
    expect((r as { reason: string }).reason).toContain('standup.example.com');
  });

  it('names an issuer mismatch', () => {
    const r = classifyFailure({ aud: '819177304171', iss: 'evil@example.com' }, ['819177304171'], 'x');
    expect((r as { reason: string }).reason).toContain('issuer mismatch');
  });

  it('falls back to signature/expiry when aud and iss look right', () => {
    const r = classifyFailure(
      { aud: '819177304171', iss: 'chat@system.gserviceaccount.com' },
      ['819177304171'],
      'Token used too late',
    );
    expect((r as { reason: string }).reason).toContain('signature or expiry');
    expect((r as { reason: string }).reason).toContain('Token used too late');
  });
});

describe('ChatRequestVerifier', () => {
  it('reports missing/malformed Authorization headers without any network call', async () => {
    const v = new ChatRequestVerifier(['819177304171']);
    expect(await v.verify(undefined)).toEqual({ ok: false, reason: 'missing or malformed Authorization header' });
    expect(await v.verify('Basic abc')).toMatchObject({ ok: false });
  });

  it('accepts either a project number or an app URL as audience', () => {
    // construction parses/normalizes a multi-audience list
    const v = new ChatRequestVerifier(['819177304171', 'https://standup.example.com/chat/events']);
    expect(v).toBeInstanceOf(ChatRequestVerifier);
  });
});
