import type { Express, Request } from 'express';
import { SAML } from '@node-saml/node-saml';
import type { SettingsService } from '../core/settings.js';
import type { UserDirectory } from '../core/directory.js';
import { newSession, sealSession, setSessionCookie } from './session.js';

/**
 * SAML assertion result, IdP-agnostic. `attributes` values may be a string
 * or an array depending on the IdP.
 */
export interface SamlProfile {
  nameId: string;
  email: string;
  displayName: string;
  attributes: Record<string, unknown>;
}

/** The SAML exchange behind an interface so routes are testable without XML. */
export interface SamlBroker {
  loginUrl(relayState: string): Promise<string>;
  consume(body: Record<string, string>): Promise<SamlProfile | null>;
  spMetadata(): string;
}

export interface SamlConfig {
  idpEntityId: string;
  idpSsoUrl: string;
  idpCert: string;
  /** SP entity id + ACS derive from the request host. */
  baseUrl: string;
}

export class NodeSamlBroker implements SamlBroker {
  private saml: SAML;

  constructor(config: SamlConfig) {
    this.saml = new SAML({
      issuer: `${config.baseUrl}/auth/saml/metadata`,
      callbackUrl: `${config.baseUrl}/auth/saml/acs`,
      entryPoint: config.idpSsoUrl,
      idpCert: config.idpCert,
      idpIssuer: config.idpEntityId,
      audience: `${config.baseUrl}/auth/saml/metadata`,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    });
  }

  async loginUrl(relayState: string): Promise<string> {
    return this.saml.getAuthorizeUrlAsync(relayState, undefined, {});
  }

  async consume(body: Record<string, string>): Promise<SamlProfile | null> {
    const { profile, loggedOut } = await this.saml.validatePostResponseAsync(body);
    if (loggedOut || !profile) return null;
    const attributes = (profile as any).attributes ?? {};
    const attr = (...names: string[]): string => {
      for (const n of names) {
        const v = attributes[n] ?? (profile as any)[n];
        if (typeof v === 'string' && v) return v;
        if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
      }
      return '';
    };
    const email =
      attr('email', 'mail', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress') ||
      (profile.nameID.includes('@') ? profile.nameID : '');
    return {
      nameId: profile.nameID,
      email,
      displayName: attr('displayName', 'name', 'cn', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name') || email,
      attributes,
    };
  }

  spMetadata(): string {
    return this.saml.generateServiceProviderMetadata(null, null);
  }
}

export interface SamlDeps {
  settings: SettingsService;
  secretKey: string;
  directory: () => Promise<UserDirectory | null>;
  /** Overridable for tests. */
  broker?: (config: SamlConfig) => SamlBroker;
}

function baseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}

/** Does the assertion carry the configured admin group/value? */
export function samlAdmin(attributes: Record<string, unknown>, attributeName: string, groupValue: string): boolean {
  const raw = attributes[attributeName];
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return values.some((v) => String(v).toLowerCase() === groupValue.toLowerCase());
}

export function registerSaml(app: Express, deps: SamlDeps): void {
  if (!deps.secretKey) return;
  const makeBroker = deps.broker ?? ((config: SamlConfig) => new NodeSamlBroker(config));

  const configured = async (req: Request) => {
    const s = await deps.settings.get();
    if (!s.samlIdpSsoUrl || !s.samlIdpCert || !s.samlIdpEntityId) return null;
    return makeBroker({
      idpEntityId: s.samlIdpEntityId,
      idpSsoUrl: s.samlIdpSsoUrl,
      idpCert: s.samlIdpCert,
      baseUrl: baseUrl(req),
    });
  };

  app.get('/auth/saml', async (req, res) => {
    const broker = await configured(req);
    if (!broker) {
      res.status(404).send('SAML is not configured — set the IdP details in dashboard settings.');
      return;
    }
    res.redirect(await broker.loginUrl('/'));
  });

  /** SP metadata — paste-ready for the IdP's custom-app setup. */
  app.get('/auth/saml/metadata', async (req, res) => {
    const broker = await configured(req);
    if (!broker) {
      res.status(404).send('SAML is not configured.');
      return;
    }
    res.header('content-type', 'application/xml').send(broker.spMetadata());
  });

  app.post('/auth/saml/acs', async (req, res) => {
    const broker = await configured(req);
    if (!broker) {
      res.status(404).send('SAML is not configured.');
      return;
    }
    try {
      const profile = await broker.consume(req.body ?? {});
      if (!profile || !profile.email) {
        res.status(403).send('SAML sign-in failed — the assertion carried no email address.');
        return;
      }
      const s = await deps.settings.get();

      // Admin: the IdP group/attribute and the Google Directory are OR'd —
      // whichever an install has configured grants the role.
      let admin = samlAdmin(profile.attributes, s.samlAdminAttribute, s.samlAdminGroup);
      // Chat identity: the Directory maps email → Google user id (users/<id>).
      // Unlike Google sign-in, an account the Directory does not know is NOT
      // rejected: the SAML IdP itself asserted org membership, and the account
      // may legitimately live outside Google (e.g. Okta-only contractors).
      let sub = '';
      const directory = await deps.directory();
      if (directory) {
        try {
          const entry = await directory.lookup(profile.email);
          if (entry?.suspended) {
            res.status(403).send('This account is suspended in the Workspace.');
            return;
          }
          if (entry) {
            admin = admin || entry.isAdmin;
            sub = entry.id ?? '';
          }
        } catch (err) {
          console.error('[auth] directory lookup during SAML sign-in failed:', err);
        }
      }

      setSessionCookie(res, sealSession(deps.secretKey, newSession({ sub, email: profile.email, name: profile.displayName, admin })));
      res.redirect(admin ? '/dashboard' : '/me');
    } catch (err) {
      console.error('[auth] SAML sign-in failed:', err);
      res.status(403).send('SAML sign-in failed — assertion rejected. Check the IdP certificate and URLs.');
    }
  });
}
