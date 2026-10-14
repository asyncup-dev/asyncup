import type { Request, Response, Router } from 'express';
import { canSomewhere, PERMISSIONS, type Permission } from '../core/permissions.js';
import { RoleService, type RoleActor, type RoleResult } from '../core/roles.js';
import type { RoleGrant } from '../core/types.js';
import { allowed, apiError, clampInt, principalOf, type ApiContext } from './shared.js';

/** Roles and grants: who may do what, and the log of every change. */
export function registerRoleRoutes(api: Router, ctx: ApiContext): void {
  const { repo } = ctx;
  const roles = new RoleService(repo, ctx.now);

  const actorOf = (req: Request<any>): RoleActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, access: p.access, externalAdmin: p.externalAdmin, email: p.user?.email ?? null, name: p.user?.name ?? 'Operator' };
  };
  const answer = <T>(res: Response, result: RoleResult<T>, send: (value: T) => void) => {
    if (result.ok) send(result.value);
    else apiError(res, result.status, result.code, result.message, result.field);
  };
  /** Anyone who can grant something: role managers, and managers of a standup's people. */
  const mayGrant = (req: Request<any>, res: Response): boolean => {
    const p = principalOf(req);
    if (allowed(p, 'roles.manage') || canSomewhere(p.access, 'people.manage')) return true;
    apiError(res, 403, 'forbidden', 'Only admins and managers can see roles.');
    return false;
  };
  const grantView = async (g: RoleGrant) => {
    const all = await roles.list(g.tenantId);
    const standup = g.standupId === null ? null : await repo.getStandupById(g.standupId);
    return {
      id: g.id,
      email: g.email,
      displayName: g.displayName,
      role: { id: g.role, name: all.find((r) => r.id === g.role)?.name ?? 'Deleted role' },
      standup: standup ? { id: standup.id, name: standup.name } : null,
      grantedBy: g.grantedBy,
      grantedAt: g.grantedAt,
    };
  };

  api.get('/permissions', (_req, res) => {
    res.json({
      permissions: (Object.keys(PERMISSIONS) as Permission[]).map((id) => ({ id, ...PERMISSIONS[id] })),
    });
  });

  api.get('/roles', async (req, res) => {
    if (!mayGrant(req, res)) return;
    res.json({ roles: await roles.list(principalOf(req).tenantId) });
  });

  api.post('/roles', async (req, res) => {
    answer(res, await roles.create(actorOf(req), req.body ?? {}), (role) => res.status(201).json(role));
  });

  api.patch('/roles/:id', async (req, res) => {
    answer(res, await roles.update(actorOf(req), String(req.params.id), req.body ?? {}), (role) => res.json(role));
  });

  api.delete('/roles/:id', async (req, res) => {
    answer(res, await roles.remove(actorOf(req), String(req.params.id)), () => res.status(204).end());
  });

  api.get('/grants', async (req, res) => {
    if (!mayGrant(req, res)) return;
    const standupId = req.query.standupId === undefined ? null : Number(req.query.standupId);
    const grants = [];
    for (const g of await roles.grants(actorOf(req), standupId)) grants.push(await grantView(g));
    res.json({ grants });
  });

  api.post('/grants', async (req, res) => {
    const result = await roles.grant(actorOf(req), req.body ?? {});
    if (!result.ok) return apiError(res, result.status, result.code, result.message, result.field);
    res.status(201).json(await grantView(result.value));
  });

  api.delete('/grants/:id', async (req, res) => {
    answer(res, await roles.revoke(actorOf(req), Number(req.params.id)), () => res.status(204).end());
  });

  api.get('/roles/audit', async (req, res) => {
    const p = principalOf(req);
    if (!allowed(p, 'roles.manage')) return apiError(res, 403, 'forbidden', 'Only people who can manage roles can see their history.');
    res.json({ entries: await repo.listRoleAudit(p.tenantId, clampInt(req.query.limit, 100, 1, 500)) });
  });
}
