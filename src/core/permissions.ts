import type { Repo } from '../db/repo.js';
import { PERMISSIONS, type Permission } from './permission-catalogue.js';
import type { CustomRole } from './types.js';

export { PERMISSIONS, type Permission } from './permission-catalogue.js';

const ALL = Object.keys(PERMISSIONS) as Permission[];

/** The roles every install has. They can be copied but not changed. */
export const BUILT_IN_ROLES = {
  admin: { name: 'Admin', permissions: ALL },
  manager: {
    name: 'Manager',
    permissions: [
      'standups.view', 'standups.configure', 'standups.archive', 'people.view', 'people.manage', 'schedules.manage',
      'answers.view', 'blockers.view', 'blockers.manage', 'reports.view', 'export',
    ] as Permission[],
  },
  viewer: { name: 'Viewer', permissions: ['standups.view', 'people.view', 'answers.view', 'blockers.view', 'reports.view', 'export'] as Permission[] },
  member: { name: 'Member', permissions: ['standups.view', 'answers.view', 'blockers.view', 'reports.view'] as Permission[] },
};

/** In catalogue order, without repeats. */
export function orderedPermissions(held: Iterable<Permission>): Permission[] {
  const set = new Set(held);
  return ALL.filter((p) => set.has(p));
}

/** Built-in roles that can be granted; Member comes from being on a roster. */
export const GRANTABLE_BUILT_INS = ['admin', 'manager', 'viewer'] as const;

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}

/** A grant's permissions: a built-in role's, or a custom role's that still exist. */
export function permissionsOf(role: string, custom: ReadonlyMap<string, CustomRole>): Permission[] {
  if ((GRANTABLE_BUILT_INS as readonly string[]).includes(role)) return BUILT_IN_ROLES[role as (typeof GRANTABLE_BUILT_INS)[number]].permissions;
  return (custom.get(role)?.permissions ?? []).filter(isPermission);
}

/** Permissions held across the workspace, and per standup on top of those. */
export interface Access {
  workspace: ReadonlySet<Permission>;
  standups: ReadonlyMap<number, ReadonlySet<Permission>>;
}

export function can(access: Access, permission: Permission, standupId?: number): boolean {
  if (access.workspace.has(permission)) return true;
  return standupId !== undefined && !!access.standups.get(standupId)?.has(permission);
}

/** Held across the workspace or on at least one standup. */
export function canSomewhere(access: Access, permission: Permission): boolean {
  return access.workspace.has(permission) || [...access.standups.values()].some((held) => held.has(permission));
}

/** Standups where the permission is held on its own; a workspace-wide holder has it on every standup. */
export function standupsWith(access: Access, permission: Permission): number[] {
  return [...access.standups].filter(([, held]) => held.has(permission)).map(([id]) => id);
}

/**
 * The coarse role the web app lays out its navigation by: admin with the
 * workspace settings, manager with anything beyond answering, else member.
 */
export function roleKind(access: Access, externalAdmin: boolean, administers: number): 'admin' | 'manager' | 'member' {
  if (externalAdmin || access.workspace.has('settings.manage')) return 'admin';
  const member = new Set<Permission>(BUILT_IN_ROLES.member.permissions);
  const held = [...access.workspace, ...[...access.standups.values()].flatMap((s) => [...s])];
  return administers > 0 || held.some((p) => !member.has(p)) ? 'manager' : 'member';
}

export interface Who {
  tenantId: string;
  userName: string | null;
  /** Grants are keyed by email; looked up from the Chat user when not given. */
  email?: string | null;
}

/**
 * A person's access: workspace admins hold everything; otherwise Member on
 * each roster they are on, Manager on each standup they administer, and
 * whatever roles they were granted by email.
 */
export async function resolveAccess(repo: Repo, who: Who, workspaceAdmin: boolean): Promise<Access> {
  if (workspaceAdmin) return { workspace: new Set(BUILT_IN_ROLES.admin.permissions), standups: new Map() };
  const workspace = new Set<Permission>();
  const standups = new Map<number, Set<Permission>>();
  const grant = (id: number, permissions: Permission[]) => {
    const held = standups.get(id) ?? new Set<Permission>();
    for (const p of permissions) held.add(p);
    standups.set(id, held);
  };
  if (who.userName) {
    for (const s of await repo.listStandupsForUser(who.userName)) grant(s.id, BUILT_IN_ROLES.member.permissions);
    for (const s of await repo.listStandupsAdministeredBy(who.userName)) grant(s.id, BUILT_IN_ROLES.manager.permissions);
  }
  const email = (who.email ?? (who.userName ? await repo.getUserEmail(who.userName) : null))?.toLowerCase();
  const grants = email ? await repo.listGrants(who.tenantId, { email }) : [];
  if (grants.length > 0) {
    const custom = new Map((await repo.listRoles(who.tenantId)).map((r) => [String(r.id), r]));
    for (const g of grants) {
      const permissions = permissionsOf(g.role, custom);
      if (g.standupId === null) for (const p of permissions) workspace.add(p);
      else grant(g.standupId, permissions.filter((p) => !PERMISSIONS[p].workspaceOnly));
    }
  }
  return { workspace, standups };
}
