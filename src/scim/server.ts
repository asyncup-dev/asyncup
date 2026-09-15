import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { DateTime } from 'luxon';
import { tokenEquals } from '../core/crypto.js';
import type { UserDirectory } from '../core/directory.js';
import type { SettingsService } from '../core/settings.js';
import type { ScimUser } from '../core/types.js';
import type { Repo } from '../db/repo.js';

/**
 * SCIM 2.0 Users endpoint (RFC 7643/7644 — the subset Okta, Entra and
 * OneLogin drive): bearer-token auth, create, lookup by userName filter,
 * PUT/PATCH updates, deactivation. Deactivating (or deleting) a user
 * removes them from every standup roster — offboarding actually offboards.
 * Google Workspace itself cannot push SCIM to custom apps; Google-native
 * installs keep the Directory pull instead.
 */
export interface ScimDeps {
  repo: Repo;
  settings: SettingsService;
  directory: () => Promise<UserDirectory | null>;
  now?: () => DateTime;
}

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

function scimError(res: Response, status: number, detail: string): void {
  res.status(status).json({ schemas: [ERROR_SCHEMA], status: String(status), detail });
}

function render(u: ScimUser): object {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    ...(u.externalId ? { externalId: u.externalId } : {}),
    userName: u.userName,
    ...(u.displayName ? { displayName: u.displayName } : {}),
    ...(u.email ? { emails: [{ value: u.email, primary: true }] } : {}),
    active: u.active,
    meta: { resourceType: 'User', location: `/scim/v2/Users/${u.id}` },
  };
}

function parseBody(body: any): { externalId: string | null; userName: string; displayName: string | null; email: string | null; active: boolean } {
  const emails: any[] = Array.isArray(body?.emails) ? body.emails : [];
  const primary = emails.find((e) => e?.primary) ?? emails[0];
  const userName = String(body?.userName ?? '').trim();
  return {
    externalId: body?.externalId ? String(body.externalId) : null,
    userName,
    displayName: body?.displayName ? String(body.displayName) : body?.name?.formatted ? String(body.name.formatted) : null,
    email: primary?.value ? String(primary.value) : userName.includes('@') ? userName : null,
    active: body?.active !== false,
  };
}

export function registerScim(app: Express, deps: ScimDeps): void {
  const { repo } = deps;
  const now = deps.now ?? (() => DateTime.utc());

  // Provisioners send application/scim+json, which the default JSON parser skips.
  app.use('/scim', express.json({ type: ['application/json', 'application/scim+json'] }));

  const authed = async (req: Request, res: Response): Promise<boolean> => {
    const { scimToken } = await deps.settings.get();
    const bearer = req.header('authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (!scimToken) {
      scimError(res, 404, 'SCIM is disabled — generate a SCIM token in dashboard settings.');
      return false;
    }
    if (!tokenEquals(bearer, scimToken)) {
      scimError(res, 401, 'Invalid bearer token.');
      return false;
    }
    return true;
  };

  /** Email → Chat resource name, via Directory or previously cached emails. */
  const resolveChatUser = async (email: string | null): Promise<string | null> => {
    if (!email) return null;
    const cached = await repo.findUserNameByEmail(email);
    if (cached) return cached;
    try {
      const directory = await deps.directory();
      const entry = directory && (await directory.lookup(email));
      if (entry?.id) {
        const chatUserName = `users/${entry.id}`;
        await repo.setUserEmail(chatUserName, email);
        return chatUserName;
      }
    } catch (err) {
      console.error('[scim] directory lookup failed:', err);
    }
    return null;
  };

  const offboard = async (u: ScimUser): Promise<void> => {
    const chatUserName = u.chatUserName ?? (await resolveChatUser(u.email));
    if (chatUserName) {
      const removed = await repo.removeParticipantEverywhere(chatUserName);
      if (removed > 0) console.log(`[scim] deactivated ${u.userName} — removed from ${removed} roster(s)`);
    }
  };

  app.get('/scim/v2/ServiceProviderConfig', async (req, res) => {
    if (!(await authed(req, res))) return;
    res.json({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Dashboard-generated SCIM token' }],
    });
  });

  app.get('/scim/v2/Users', async (req, res) => {
    if (!(await authed(req, res))) return;
    const filter = String(req.query.filter ?? '');
    if (filter) {
      // The one filter provisioners use for dedupe: userName eq "value"
      const m = filter.match(/^userName eq "([^"]*)"$/i);
      if (!m) {
        scimError(res, 501, 'Only the filter form userName eq "value" is supported.');
        return;
      }
      const user = await repo.findScimUserByUserName(m[1]!);
      res.json({ schemas: [LIST_SCHEMA], totalResults: user ? 1 : 0, startIndex: 1, itemsPerPage: user ? 1 : 0, Resources: user ? [render(user)] : [] });
      return;
    }
    const startIndex = Math.max(1, Number(req.query.startIndex) || 1);
    const count = Math.min(200, Math.max(0, Number(req.query.count) || 100));
    const { total, users } = await repo.listScimUsers(startIndex, count);
    res.json({ schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: users.length, Resources: users.map(render) });
  });

  app.get('/scim/v2/Users/:id', async (req, res) => {
    if (!(await authed(req, res))) return;
    const user = await repo.getScimUser(String(req.params.id));
    if (!user) return scimError(res, 404, 'User not found.');
    res.json(render(user));
  });

  app.post('/scim/v2/Users', async (req, res) => {
    if (!(await authed(req, res))) return;
    const parsed = parseBody(req.body);
    if (!parsed.userName) return scimError(res, 400, 'userName is required.');
    if (await repo.findScimUserByUserName(parsed.userName)) {
      return scimError(res, 409, 'A user with this userName already exists.');
    }
    const user: ScimUser = {
      id: randomUUID(),
      ...parsed,
      chatUserName: await resolveChatUser(parsed.email),
    };
    await repo.createScimUser({ ...user, at: now().toISO()! });
    if (!user.active) await offboard(user);
    res.status(201).json(render(user));
  });

  app.put('/scim/v2/Users/:id', async (req, res) => {
    if (!(await authed(req, res))) return;
    const existing = await repo.getScimUser(String(req.params.id));
    if (!existing) return scimError(res, 404, 'User not found.');
    const parsed = parseBody(req.body);
    if (!parsed.userName) return scimError(res, 400, 'userName is required.');
    const chatUserName = existing.chatUserName ?? (await resolveChatUser(parsed.email));
    await repo.updateScimUser(existing.id, { ...parsed, chatUserName }, now().toISO()!);
    const updated = (await repo.getScimUser(existing.id))!;
    if (existing.active && !updated.active) await offboard(updated);
    res.json(render(updated));
  });

  app.patch('/scim/v2/Users/:id', async (req, res) => {
    if (!(await authed(req, res))) return;
    const existing = await repo.getScimUser(String(req.params.id));
    if (!existing) return scimError(res, 404, 'User not found.');
    if (!Array.isArray(req.body?.Operations) || !req.body.schemas?.includes(PATCH_SCHEMA)) {
      return scimError(res, 400, 'Expected a PatchOp with Operations.');
    }
    const fields: { active?: boolean; displayName?: string | null; userName?: string; externalId?: string | null } = {};
    for (const op of req.body.Operations) {
      const kind = String(op?.op ?? '').toLowerCase();
      if (kind !== 'replace' && kind !== 'add') continue;
      // Okta/Entra send either {path, value} or a bare {value: {field: …}} map.
      const entries: [string, unknown][] = op.path ? [[String(op.path), op.value]] : Object.entries(op.value ?? {});
      for (const [path, value] of entries) {
        if (path === 'active') fields.active = value === true || value === 'True' || value === 'true';
        else if (path === 'displayName' || path === 'name.formatted') fields.displayName = value ? String(value) : null;
        else if (path === 'userName') fields.userName = String(value);
        else if (path === 'externalId') fields.externalId = value ? String(value) : null;
      }
    }
    await repo.updateScimUser(existing.id, fields, now().toISO()!);
    const updated = (await repo.getScimUser(existing.id))!;
    if (existing.active && !updated.active) await offboard(updated);
    res.json(render(updated));
  });

  app.delete('/scim/v2/Users/:id', async (req, res) => {
    if (!(await authed(req, res))) return;
    const existing = await repo.getScimUser(String(req.params.id));
    if (!existing) return scimError(res, 404, 'User not found.');
    await repo.updateScimUser(existing.id, { active: false }, now().toISO()!);
    if (existing.active) await offboard({ ...existing, active: false });
    res.status(204).end();
  });
}
