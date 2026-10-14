import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Grant, PermissionInfo, Role, RoleAuditEntry } from '../../../src/api/spec/schemas.ts';
import type { Permission } from './access';
import { api } from './api';

export type { Grant, PermissionInfo, Role, RoleAuditEntry };

export function usePermissionCatalogue() {
  return useQuery({ queryKey: ['permissions'], queryFn: () => api<{ permissions: PermissionInfo[] }>('/permissions'), select: (d) => d.permissions, staleTime: Infinity });
}

export function useRoles(enabled = true) {
  return useQuery({ queryKey: ['roles'], queryFn: () => api<{ roles: Role[] }>('/roles'), select: (d) => d.roles, enabled });
}

/** Grants the caller may see: all of them for role managers, else those on standups whose people they manage. */
export function useGrants(standupId?: number, enabled = true) {
  const qs = standupId === undefined ? '' : `?standupId=${standupId}`;
  return useQuery({ queryKey: ['grants', standupId ?? 'all'], queryFn: () => api<{ grants: Grant[] }>(`/grants${qs}`), select: (d) => d.grants, enabled });
}

export function useRoleAudit(limit = 20) {
  return useQuery({ queryKey: ['role-audit', limit], queryFn: () => api<{ entries: RoleAuditEntry[] }>(`/roles/audit?limit=${limit}`), select: (d) => d.entries });
}

/** Role and grant changes move counts, holders and the audit log, and may change the caller's own access. */
function useInvalidateAccess() {
  const client = useQueryClient();
  return () =>
    Promise.all(['roles', 'grants', 'role-audit', 'me'].map((key) => client.invalidateQueries({ queryKey: [key] })));
}

export interface RoleDraft {
  name: string;
  description: string;
  permissions: Permission[];
}

export function useSaveRole() {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: ({ id, draft }: { id: string | null; draft: RoleDraft }) =>
      id === null ? api<Role>('/roles', { method: 'POST', body: draft }) : api<Role>(`/roles/${id}`, { method: 'PATCH', body: draft }),
    onSuccess: invalidate,
  });
}

export function useDeleteRole() {
  const invalidate = useInvalidateAccess();
  return useMutation({ mutationFn: (id: string) => api<undefined>(`/roles/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
}

export function useGrant() {
  const invalidate = useInvalidateAccess();
  return useMutation({
    mutationFn: (body: { email: string; displayName?: string; role: string; standupId: number | null }) => api<Grant>('/grants', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useRevoke() {
  const invalidate = useInvalidateAccess();
  return useMutation({ mutationFn: (id: number) => api<undefined>(`/grants/${id}`, { method: 'DELETE' }), onSuccess: invalidate });
}

/** Roles the caller can hand out at a scope: grantable, allowed there, and wholly held by the caller there. */
export function grantableAt(roles: Role[], held: ReadonlySet<Permission>, standupId: number | null): Role[] {
  return roles.filter((r) => r.grantable && (standupId === null || !r.workspaceOnly) && r.permissions.every((p) => held.has(p)));
}

/** "Asha Rao" or the email when the name is just the email again. */
export function grantee(g: Grant): string {
  return g.displayName && g.displayName !== g.email ? g.displayName : g.email;
}
