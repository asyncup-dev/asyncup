import type { Request } from 'express';
import { sessionFrom, type Session } from '../auth/session.js';
import { tokenEquals } from '../core/crypto.js';
import { chatUserName } from '../core/directory.js';
import { bearerToken } from '../core/http.js';
import type { SettingsService } from '../core/settings.js';
import type { Repo } from '../db/repo.js';

/**
 * Who is calling the JSON API. One resolver for every route, so the roles
 * are defined in exactly one place:
 *
 * - admin   — Workspace admin session, or the operator token
 * - manager — a signed-in person who administers at least one standup
 * - member  — any other signed-in person
 *
 * tenantId is carried on the principal from day one. A self-hosted install
 * has a single tenant; a hosted deployment resolves it from the session's
 * workspace instead, and no handler has to change.
 */
export type PrincipalKind = 'admin' | 'manager' | 'member';

export interface Principal {
  kind: PrincipalKind;
  via: 'session' | 'token';
  tenantId: string;
  /** null for the operator token — it is not a person. */
  user: { userName: string | null; email: string; name: string } | null;
  /** Standups this person administers. Empty for admins, who see everything. */
  managedStandupIds: number[];
}

export interface PrincipalDeps {
  repo: Repo;
  settings: SettingsService;
  /** Verifies session cookies; empty disables session auth. */
  secretKey: string;
  /** DASHBOARD_TOKEN; honoured as a bearer token while token sign-in is on. */
  operatorToken: string;
  tenantId: string;
}

export type Resolution = { principal: Principal } | { error: 'unauthenticated' | 'bad_token' };

/** Google sign-ins carry the Chat user id; SAML sign-ins may only carry an email. */
async function userNameFor(session: Session, repo: Repo): Promise<string | null> {
  return session.sub ? chatUserName(session.sub) : repo.findUserNameByEmail(session.email);
}

export async function resolvePrincipal(req: Request, deps: PrincipalDeps): Promise<Resolution> {
  const session = deps.secretKey ? sessionFrom(req, deps.secretKey) : null;
  if (session) {
    const userName = await userNameFor(session, deps.repo);
    const user = { userName, email: session.email, name: session.name };
    if (session.admin) {
      return { principal: { kind: 'admin', via: 'session', tenantId: deps.tenantId, user, managedStandupIds: [] } };
    }
    const managed = userName ? await deps.repo.listStandupsAdministeredBy(userName) : [];
    return {
      principal: {
        kind: managed.length > 0 ? 'manager' : 'member',
        via: 'session',
        tenantId: deps.tenantId,
        user,
        managedStandupIds: managed.map((s) => s.id),
      },
    };
  }

  const bearer = bearerToken(req);
  if (bearer === undefined) return { error: 'unauthenticated' };
  const { tokenSignIn } = await deps.settings.get();
  if (deps.operatorToken && tokenSignIn && tokenEquals(bearer, deps.operatorToken)) {
    return { principal: { kind: 'admin', via: 'token', tenantId: deps.tenantId, user: null, managedStandupIds: [] } };
  }
  return { error: 'bad_token' };
}
