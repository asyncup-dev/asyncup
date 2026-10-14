import type { DateTime } from 'luxon';
import type { Repo } from '../db/repo.js';
import {
  BUILT_IN_ROLES,
  can,
  GRANTABLE_BUILT_INS,
  isPermission,
  orderedPermissions as ordered,
  PERMISSIONS,
  permissionsOf,
  type Access,
  type Permission,
} from './permissions.js';
import type { CustomRole, RoleGrant } from './types.js';
import { LIMITS, looksLikeEmail } from './validation.js';

/** Who is changing roles, as the API sees them. */
export interface RoleActor {
  tenantId: string;
  access: Access;
  /** Admin through Google, SAML or the operator token: no grant change can lock them out. */
  externalAdmin: boolean;
  email: string | null;
  name: string;
}

export type RoleFailure = { ok: false; status: 400 | 403 | 404 | 409; code: string; message: string; field?: string };
export type RoleResult<T> = { ok: true; value: T } | RoleFailure;

export const ROLE_NAME_MAX = 40;

const BUILT_IN_DESCRIPTIONS: Record<keyof typeof BUILT_IN_ROLES, string> = {
  admin: 'Everything, across the workspace.',
  manager: 'Runs standups: their settings, people, schedules and blockers.',
  viewer: 'Reads standups, answers, blockers and reports, and exports them.',
  member: 'Answers their own standups. Comes from being on a roster, so it cannot be granted.',
};

export interface RoleView {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  builtIn: boolean;
  grantable: boolean;
  /** Holds a workspace-only permission, so it can only be granted across the workspace. */
  workspaceOnly: boolean;
  grants: number;
}

const fail = (status: RoleFailure['status'], code: string, message: string, field?: string): RoleFailure => ({
  ok: false,
  status,
  code,
  message,
  ...(field ? { field } : {}),
});


const hasWorkspaceOnly = (permissions: Permission[]) => permissions.some((p) => PERMISSIONS[p].workspaceOnly);

/** What the actor holds at a scope: the workspace, or one standup on top of it. */
export const heldAt = (access: Access, standupId: number | null): Set<Permission> =>
  new Set([...access.workspace, ...(standupId === null ? [] : (access.standups.get(standupId) ?? []))]);

/**
 * Custom roles and grants, with two guards: nobody hands out a permission
 * they don't hold themselves, and nobody removes their own way to manage
 * roles (someone else, or the operator token, has to).
 */
export class RoleService {
  constructor(
    private repo: Repo,
    private now: () => DateTime,
  ) {}

  private async customRoles(tenantId: string): Promise<Map<string, CustomRole>> {
    return new Map((await this.repo.listRoles(tenantId)).map((r) => [String(r.id), r]));
  }

  async list(tenantId: string): Promise<RoleView[]> {
    const grants = await this.repo.listGrants(tenantId);
    const count = (id: string) => grants.filter((g) => g.role === id).length;
    const builtIn = (Object.keys(BUILT_IN_ROLES) as (keyof typeof BUILT_IN_ROLES)[]).map((id) => ({
      id,
      name: BUILT_IN_ROLES[id].name,
      description: BUILT_IN_DESCRIPTIONS[id],
      permissions: BUILT_IN_ROLES[id].permissions,
      builtIn: true,
      grantable: (GRANTABLE_BUILT_INS as readonly string[]).includes(id),
      workspaceOnly: hasWorkspaceOnly(BUILT_IN_ROLES[id].permissions),
      grants: count(id),
    }));
    const custom = (await this.repo.listRoles(tenantId)).map((r) => this.view(r, count(String(r.id))));
    return [...builtIn, ...custom];
  }

  private view(r: CustomRole, grants: number): RoleView {
    const permissions = ordered(r.permissions.filter(isPermission));
    return { id: String(r.id), name: r.name, description: r.description, permissions, builtIn: false, grantable: true, workspaceOnly: hasWorkspaceOnly(permissions), grants };
  }

  private async log(actor: RoleActor, action: string, summary: string): Promise<void> {
    await this.repo.logRoleChange({ tenantId: actor.tenantId, at: this.now().toUTC().toISO()!, actor: actor.name, action, summary });
  }

  /** A role's name, description and permissions from a request body, checked. */
  private async parseRole(actor: RoleActor, body: Record<string, unknown>, exceptId?: number): Promise<RoleResult<{ name: string; description: string; permissions: Permission[] }>> {
    const name = String(body.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > ROLE_NAME_MAX) return fail(400, 'invalid', `Give the role a name of up to ${ROLE_NAME_MAX} characters.`, 'name');
    const description = String(body.description ?? '').trim();
    if (description.length > LIMITS.textMax) return fail(400, 'invalid', `Keep the description to ${LIMITS.textMax} characters.`, 'description');
    if (!Array.isArray(body.permissions) || body.permissions.length === 0) return fail(400, 'invalid', 'Pick at least one permission.', 'permissions');
    const unknown = body.permissions.filter((p) => typeof p !== 'string' || !isPermission(p));
    if (unknown.length) return fail(400, 'invalid', `Unknown permission: ${unknown.map(String).join(', ')}.`, 'permissions');
    const chosen = body.permissions as Permission[];
    // Every other standup permission works on a standup the holder can see.
    const permissions = ordered(chosen.some((p) => !PERMISSIONS[p].workspaceOnly) ? [...chosen, 'standups.view'] : chosen);
    const taken = [...Object.values(BUILT_IN_ROLES).map((r) => r.name), ...(await this.repo.listRoles(actor.tenantId)).filter((r) => r.id !== exceptId).map((r) => r.name)];
    if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) return fail(409, 'duplicate', `A role called “${name}” already exists.`, 'name');
    const missing = permissions.filter((p) => !actor.access.workspace.has(p));
    if (missing.length) return fail(403, 'escalation', `You can only give a role permissions you hold yourself. You don’t hold: ${missing.join(', ')}.`, 'permissions');
    return { ok: true, value: { name, description, permissions } };
  }

  private requireRoles(actor: RoleActor): RoleFailure | null {
    return can(actor.access, 'roles.manage') ? null : fail(403, 'forbidden', 'Only people who can manage roles can do that.');
  }

  async create(actor: RoleActor, body: Record<string, unknown>): Promise<RoleResult<RoleView>> {
    const denied = this.requireRoles(actor);
    if (denied) return denied;
    const parsed = await this.parseRole(actor, body);
    if (!parsed.ok) return parsed;
    const role = await this.repo.createRole({ tenantId: actor.tenantId, ...parsed.value, at: this.now().toUTC().toISO()! });
    await this.log(actor, 'role.create', `Created role “${role.name}”: ${parsed.value.permissions.join(', ')}.`);
    return { ok: true, value: this.view(role, 0) };
  }

  private async findCustom(tenantId: string, id: string): Promise<RoleResult<CustomRole>> {
    if (Object.hasOwn(BUILT_IN_ROLES, id)) return fail(400, 'built_in', 'Built-in roles can’t be changed. Copy one into a new role instead.');
    const role = /^\d+$/.test(id) ? await this.repo.getRole(tenantId, Number(id)) : null;
    return role ? { ok: true, value: role } : fail(404, 'not_found', 'No such role.');
  }

  /** Whether the actor manages roles through a grant now, and would stop if this grant went or this role changed. */
  private async wouldLockOut(actor: RoleActor, dropGrant: number | null, editedRole: { id: string; permissions: Permission[] } | null): Promise<boolean> {
    if (actor.externalAdmin || !actor.email) return false;
    const before = await this.customRoles(actor.tenantId);
    const after = new Map(before);
    if (editedRole) after.set(editedRole.id, { ...before.get(editedRole.id)!, permissions: editedRole.permissions });
    const mine = (await this.repo.listGrants(actor.tenantId, { email: actor.email.toLowerCase() })).filter((g) => g.standupId === null);
    const manages = (grants: RoleGrant[], custom: Map<string, CustomRole>) => grants.some((g) => permissionsOf(g.role, custom).includes('roles.manage'));
    return manages(mine, before) && !manages(mine.filter((g) => g.id !== dropGrant), after);
  }

  async update(actor: RoleActor, id: string, body: Record<string, unknown>): Promise<RoleResult<RoleView>> {
    const denied = this.requireRoles(actor);
    if (denied) return denied;
    const found = await this.findCustom(actor.tenantId, id);
    if (!found.ok) return found;
    const role = found.value;
    const parsed = await this.parseRole(actor, body, role.id);
    if (!parsed.ok) return parsed;
    if (await this.wouldLockOut(actor, null, { id, permissions: parsed.value.permissions })) {
      return fail(409, 'lockout', 'That would take away your own permission to manage roles. Ask another admin to make this change.');
    }
    await this.repo.updateRole(role.id, { ...parsed.value, at: this.now().toUTC().toISO()! });
    const before = new Set(role.permissions);
    const added = parsed.value.permissions.filter((p) => !before.has(p));
    const removed = role.permissions.filter((p) => !parsed.value.permissions.includes(p as Permission));
    const parts = [
      ...(role.name !== parsed.value.name ? [`renamed to “${parsed.value.name}”`] : []),
      ...(added.length ? [`added ${added.join(', ')}`] : []),
      ...(removed.length ? [`removed ${removed.join(', ')}`] : []),
    ];
    await this.log(actor, 'role.update', `Changed role “${role.name}”: ${parts.join('; ') || 'description only'}.`);
    return { ok: true, value: this.view((await this.repo.getRole(actor.tenantId, role.id))!, (await this.repo.listGrants(actor.tenantId, { role: id })).length) };
  }

  async remove(actor: RoleActor, id: string): Promise<RoleResult<null>> {
    const denied = this.requireRoles(actor);
    if (denied) return denied;
    const found = await this.findCustom(actor.tenantId, id);
    if (!found.ok) return found;
    const inUse = (await this.repo.listGrants(actor.tenantId, { role: id })).length;
    if (inUse) return fail(409, 'in_use', `${inUse} ${inUse === 1 ? 'person holds' : 'grants use'} this role. Revoke ${inUse === 1 ? 'it' : 'them'} first.`);
    await this.repo.deleteRole(found.value.id);
    await this.log(actor, 'role.delete', `Deleted role “${found.value.name}”.`);
    return { ok: true, value: null };
  }

  /** Grants on the whole workspace need roles.manage; on one standup, managing its people is enough. */
  private mayGrantAt(actor: RoleActor, standupId: number | null): boolean {
    return can(actor.access, 'roles.manage') || (standupId !== null && can(actor.access, 'people.manage', standupId));
  }

  /** The grants the actor may see and change. */
  async grants(actor: RoleActor, standupId: number | null): Promise<RoleGrant[]> {
    return (await this.repo.listGrants(actor.tenantId)).filter(
      (g) => (standupId === null || g.standupId === standupId) && (can(actor.access, 'roles.manage') || (g.standupId !== null && this.mayGrantAt(actor, g.standupId))),
    );
  }

  private async roleName(tenantId: string, role: string): Promise<string> {
    if (Object.hasOwn(BUILT_IN_ROLES, role)) return BUILT_IN_ROLES[role as keyof typeof BUILT_IN_ROLES].name;
    return (await this.repo.getRole(tenantId, Number(role)))?.name ?? 'a deleted role';
  }

  private async scopeName(standupId: number | null): Promise<string> {
    return standupId === null ? 'across the workspace' : `on ${(await this.repo.getStandupById(standupId))?.name ?? `standup ${standupId}`}`;
  }

  async grant(actor: RoleActor, body: Record<string, unknown>): Promise<RoleResult<RoleGrant>> {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!looksLikeEmail(email)) return fail(400, 'invalid', 'Give the person’s email address.', 'email');
    const displayName = String(body.displayName ?? '').replace(/\s+/g, ' ').trim();
    if (displayName.length > LIMITS.textMax) return fail(400, 'invalid', `Keep the name to ${LIMITS.textMax} characters.`, 'displayName');
    const standupId = body.standupId === undefined || body.standupId === null ? null : Number(body.standupId);
    if (standupId !== null) {
      const standup = Number.isInteger(standupId) ? await this.repo.getStandupById(standupId) : null;
      if (!standup || standup.tenantId !== actor.tenantId) return fail(404, 'not_found', 'No such standup.', 'standupId');
    }
    if (!this.mayGrantAt(actor, standupId)) {
      return fail(403, 'forbidden', standupId === null ? 'Only people who can manage roles can grant across the workspace.' : 'Only people who manage this standup’s people can grant roles on it.');
    }
    const role = String(body.role ?? '');
    const custom = await this.customRoles(actor.tenantId);
    if (!(GRANTABLE_BUILT_INS as readonly string[]).includes(role) && !custom.has(role)) return fail(400, 'invalid', 'Pick a role that can be granted.', 'role');
    const permissions = permissionsOf(role, custom);
    if (standupId !== null && hasWorkspaceOnly(permissions)) {
      return fail(400, 'workspace_only', 'This role has workspace-wide permissions, so it can only be granted across the workspace.', 'standupId');
    }
    const held = heldAt(actor.access, standupId);
    const missing = permissions.filter((p) => !held.has(p));
    if (missing.length) return fail(403, 'escalation', `You can only grant roles whose permissions you hold here. You don’t hold: ${missing.join(', ')}.`, 'role');
    const existing = await this.repo.listGrants(actor.tenantId, { email, role });
    if (existing.some((g) => g.standupId === standupId)) return fail(409, 'duplicate', `${email} already has that role there.`);
    const grant = await this.repo.createGrant({
      tenantId: actor.tenantId,
      email,
      displayName: displayName || email,
      role,
      standupId,
      grantedBy: actor.name,
      grantedAt: this.now().toUTC().toISO()!,
    });
    await this.log(actor, 'grant.create', `Granted ${await this.roleName(actor.tenantId, role)} to ${email} ${await this.scopeName(standupId)}.`);
    return { ok: true, value: grant };
  }

  async revoke(actor: RoleActor, id: number): Promise<RoleResult<null>> {
    const grant = await this.repo.getGrant(actor.tenantId, id);
    if (!grant || !this.mayGrantAt(actor, grant.standupId)) return fail(404, 'not_found', 'No such grant.');
    const held = heldAt(actor.access, grant.standupId);
    const missing = permissionsOf(grant.role, await this.customRoles(actor.tenantId)).filter((p) => !held.has(p));
    if (missing.length) return fail(403, 'escalation', `You can only revoke roles whose permissions you hold here. You don’t hold: ${missing.join(', ')}.`);
    if (await this.wouldLockOut(actor, grant.id, null)) {
      return fail(409, 'lockout', 'That would take away your own permission to manage roles. Ask another admin to revoke it.');
    }
    await this.repo.deleteGrant(grant.id);
    await this.log(actor, 'grant.delete', `Revoked ${await this.roleName(actor.tenantId, grant.role)} from ${grant.email} ${await this.scopeName(grant.standupId)}.`);
    return { ok: true, value: null };
  }
}
