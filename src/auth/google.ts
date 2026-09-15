import { randomBytes } from 'node:crypto';
import type { Express, Request } from 'express';
import { OAuth2Client } from 'google-auth-library';
import type { SettingsService } from '../core/settings.js';
import type { UserDirectory } from '../core/directory.js';
import { readCookie } from '../core/http.js';
import { clearSessionCookie, newSession, sealSession, setSessionCookie } from './session.js';

/**
 * The Google exchange behind an interface so routes are testable without
 * Google. `sub` in the returned identity is the Google user id.
 */
export interface IdentityBroker {
  authUrl(redirectUri: string, state: string): string;
  exchange(code: string, redirectUri: string): Promise<{ sub: string; email: string; name: string }>;
}

export class GoogleIdentityBroker implements IdentityBroker {
  constructor(
    private clientId: string,
    private clientSecret: string,
  ) {}

  authUrl(redirectUri: string, state: string): string {
    return new OAuth2Client({ clientId: this.clientId }).generateAuthUrl({
      redirect_uri: redirectUri,
      scope: ['openid', 'email', 'profile'],
      state,
    });
  }

  async exchange(code: string, redirectUri: string): Promise<{ sub: string; email: string; name: string }> {
    const client = new OAuth2Client({ clientId: this.clientId, clientSecret: this.clientSecret });
    const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token!, audience: this.clientId });
    const payload = ticket.getPayload()!;
    return { sub: payload.sub, email: payload.email ?? '', name: payload.name ?? payload.email ?? 'Unknown' };
  }
}

export interface AuthDeps {
  settings: SettingsService;
  /** Signs session cookies; empty disables Google sign-in entirely. */
  secretKey: string;
  directory: () => Promise<UserDirectory | null>;
  /** Overridable for tests. */
  broker?: (clientId: string, clientSecret: string) => IdentityBroker;
}

const STATE_COOKIE = 'asyncup_oauth_state';

function redirectUri(req: Request): string {
  // Behind the documented single reverse-proxy hop ('trust proxy' = 1),
  // req.protocol honours X-Forwarded-Proto.
  return `${req.protocol}://${req.get('host')}/auth/callback`;
}

export function registerAuth(app: Express, deps: AuthDeps): void {
  if (!deps.secretKey) return;
  const makeBroker = deps.broker ?? ((id, secret) => new GoogleIdentityBroker(id, secret));

  app.get('/auth/google', async (req, res) => {
    const { oauthClientId, oauthClientSecret } = await deps.settings.get();
    if (!oauthClientId || !oauthClientSecret) {
      res.status(404).send('Google sign-in is not configured — set the OAuth client in dashboard settings.');
      return;
    }
    const state = randomBytes(16).toString('base64url');
    res.setHeader('Set-Cookie', `${STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`);
    res.redirect(makeBroker(oauthClientId, oauthClientSecret).authUrl(redirectUri(req), state));
  });

  app.get('/auth/callback', async (req, res) => {
    const { oauthClientId, oauthClientSecret } = await deps.settings.get();
    const stateCookie = readCookie(req, STATE_COOKIE);
    if (!oauthClientId || !req.query.code || !req.query.state || req.query.state !== stateCookie) {
      res.status(400).send('Sign-in failed (state mismatch) — go back and try again.');
      return;
    }
    try {
      const identity = await makeBroker(oauthClientId, oauthClientSecret).exchange(
        String(req.query.code),
        redirectUri(req),
      );

      // Workspace membership and role come from the Directory when available.
      // Without it, everyone signs in as a regular user (admin console stays
      // reachable via DASHBOARD_TOKEN).
      let admin = false;
      const directory = await deps.directory();
      if (directory) {
        const entry = await directory.lookup(identity.sub);
        if (!entry || entry.suspended) {
          res.status(403).send('This Google account is not an active member of the Workspace.');
          return;
        }
        admin = entry.isAdmin;
      }

      setSessionCookie(res, sealSession(deps.secretKey, newSession({ ...identity, admin })));
      res.redirect(admin ? '/dashboard' : '/me');
    } catch (err) {
      console.error('[auth] Google sign-in failed:', err);
      res.status(500).send('Sign-in failed — check the OAuth client configuration and try again.');
    }
  });

  app.post('/auth/logout', (_req, res) => {
    clearSessionCookie(res);
    res.redirect('/me');
  });
}
