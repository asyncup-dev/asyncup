import type { AddressInfo } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { SAML } from '@node-saml/node-saml';
import express from 'express';
import { NodeSamlBroker, registerSaml } from '../src/auth/saml.js';
import type { SettingsService } from '../src/core/settings.js';

const CONFIG = {
  idpEntityId: 'https://idp.example',
  idpSsoUrl: 'https://idp.example/sso',
  idpCert: 'MIIC-fake-cert',
  baseUrl: 'https://standup.example.com',
};

async function consume(profile: Record<string, unknown> | null, loggedOut = false) {
  const spy = spyOn(SAML.prototype, 'validatePostResponseAsync').mockResolvedValue({
    profile: profile ? { issuer: CONFIG.idpEntityId, nameIDFormat: 'email', ...profile, nameID: String(profile.nameID) } : null,
    loggedOut,
  });
  try {
    const result = await new NodeSamlBroker(CONFIG).consume({ SAMLResponse: 'fake' });
    expect(spy).toHaveBeenCalledWith({ SAMLResponse: 'fake' });
    return result;
  } finally {
    spy.mockRestore();
  }
}

describe('NodeSamlBroker', () => {
  it('redirects to the IdP with a deflated AuthnRequest naming our SP and ACS', async () => {
    const url = new URL(await new NodeSamlBroker(CONFIG).loginUrl('/'));
    expect(url.origin + url.pathname).toBe('https://idp.example/sso');
    expect(url.searchParams.get('RelayState')).toBe('/');
    const request = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString();
    expect(request).toContain('Destination="https://idp.example/sso"');
    expect(request).toContain('AssertionConsumerServiceURL="https://standup.example.com/auth/saml/acs"');
    expect(request).toContain('https://standup.example.com/auth/saml/metadata</saml:Issuer>');
    expect(request).toContain('urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress');
  });

  it('publishes SP metadata derived from the base URL', () => {
    const xml = new NodeSamlBroker(CONFIG).spMetadata();
    expect(xml).toContain('entityID="https://standup.example.com/auth/saml/metadata"');
    expect(xml).toContain('Location="https://standup.example.com/auth/saml/acs"');
    expect(xml).toContain('WantAssertionsSigned="true"');
  });

  it('reads email and display name from string or array attributes', async () => {
    expect(
      await consume({ nameID: 'abc123', attributes: { mail: ['alice@example.com'], cn: 'Alice Example', groups: ['admins'] } }),
    ).toEqual({
      nameId: 'abc123',
      email: 'alice@example.com',
      displayName: 'Alice Example',
      attributes: { mail: ['alice@example.com'], cn: 'Alice Example', groups: ['admins'] },
    });
  });

  it('falls back to top-level profile fields, then an email-shaped nameID, then email as the name', async () => {
    expect(await consume({ nameID: 'bob@example.com', displayName: 'Bob' })).toEqual({
      nameId: 'bob@example.com',
      email: 'bob@example.com',
      displayName: 'Bob',
      attributes: {},
    });
    expect(await consume({ nameID: 'carol@example.com', attributes: { name: [42], email: '' } })).toEqual({
      nameId: 'carol@example.com',
      email: 'carol@example.com',
      displayName: 'carol@example.com',
      attributes: { name: [42], email: '' },
    });
    expect((await consume({ nameID: 'opaque-id' }))?.email).toBe('');
  });

  it('returns null for logout responses and empty assertions', async () => {
    expect(await consume(null)).toBeNull();
    expect(await consume({ nameID: 'x@example.com' }, true)).toBeNull();
  });
});

describe('GET /auth/saml with the real broker', () => {
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
  });

  function listen(saml: Record<string, string>) {
    const app = express();
    registerSaml(app, {
      settings: { get: async () => saml } as unknown as SettingsService,
      secretKey: 'saml-secret-key',
      directory: async () => null,
    });
    const server = app.listen(0);
    close = () => server.close();
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('redirects to the IdP with an AuthnRequest whose ACS is derived from the request host', async () => {
    const url = listen({ samlIdpEntityId: CONFIG.idpEntityId, samlIdpSsoUrl: CONFIG.idpSsoUrl, samlIdpCert: CONFIG.idpCert });
    const res = await fetch(`${url}/auth/saml`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(CONFIG.idpSsoUrl);
    const request = inflateRawSync(Buffer.from(location.searchParams.get('SAMLRequest')!, 'base64')).toString();
    expect(request).toContain(`AssertionConsumerServiceURL="${url}/auth/saml/acs"`);
  });

  it('is a 404 until the IdP details are configured', async () => {
    const url = listen({ samlIdpEntityId: CONFIG.idpEntityId });
    const res = await fetch(`${url}/auth/saml`, { redirect: 'manual' });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('SAML is not configured');
  });
});
