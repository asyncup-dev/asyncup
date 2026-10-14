import { useMe } from './auth';
import type { BlockerView, Me } from './api';

export type Permission = Me['permissions']['workspace'][number];

/** Held across the workspace, or on this standup. Mirrors the server's check. */
export function can(me: Me | null | undefined, permission: Permission, standupId?: number): boolean {
  if (!me) return false;
  if (me.permissions.workspace.includes(permission)) return true;
  return standupId !== undefined && !!me.permissions.standups[String(standupId)]?.includes(permission);
}

/** Held across the workspace or on at least one standup. */
export function canSomewhere(me: Me | null | undefined, permission: Permission): boolean {
  if (!me) return false;
  return me.permissions.workspace.includes(permission) || Object.values(me.permissions.standups).some((held) => held.includes(permission));
}

/** Everything held at a scope: the workspace, or one standup on top of it. */
export function heldAt(me: Me | null | undefined, standupId: number | null): Set<Permission> {
  if (!me) return new Set();
  return new Set([...me.permissions.workspace, ...(standupId === null ? [] : me.permissions.standups[String(standupId)] ?? [])]);
}

/** The owner, people tagged on it, and whoever resolves blockers on its standup. */
export function mayResolve(me: Me | null | undefined, b: BlockerView): boolean {
  const userName = me?.user?.userName;
  if (!userName) return false;
  return b.owner.userName === userName || b.tags.some((t) => t.userName === userName) || can(me, 'blockers.manage', b.standup.id);
}

/** Any of the permissions that open some part of Settings. */
export const SETTINGS_PERMISSIONS: Permission[] = ['settings.manage', 'sso.manage', 'tokens.manage', 'roles.manage'];

export function useAccess() {
  const me = useMe().data;
  return {
    me,
    can: (permission: Permission, standupId?: number) => can(me, permission, standupId),
    canSomewhere: (permission: Permission) => canSomewhere(me, permission),
  };
}
