import type { Repo } from '../db/repo.js';

/**
 * What a person may do. Roles are named sets of these; a grant gives a role
 * to someone across the workspace or on one standup.
 */
export const PERMISSIONS = {
  'standups.view': { label: 'See standups', description: 'See a standup, who is on it and how today is going', workspaceOnly: false },
  'standups.create': { label: 'Create standups', description: 'Create standups in any space the app is in', workspaceOnly: true },
  'standups.configure': { label: 'Configure standups', description: 'Change the schedule, questions, mood, escalation and webhook; run now, nudge and close polls', workspaceOnly: false },
  'standups.archive': { label: 'Archive standups', description: 'Archive a standup and bring it back', workspaceOnly: false },
  'standups.delete': { label: 'Delete standups', description: 'Delete an archived standup with all its history', workspaceOnly: true },
  'people.view': { label: 'See the team', description: 'See the Team directory', workspaceOnly: false },
  'people.manage': { label: 'Manage people', description: 'Add and remove people, mark them required, make managers', workspaceOnly: false },
  'schedules.manage': { label: 'Manage schedules', description: 'Change people’s weeks and days off, and decide time-off requests', workspaceOnly: false },
  'answers.view': { label: 'Read answers', description: 'Read each day’s answers', workspaceOnly: false },
  'blockers.view': { label: 'See blockers', description: 'See blockers and their updates', workspaceOnly: false },
  'blockers.manage': { label: 'Resolve blockers', description: 'Resolve anyone’s blocker', workspaceOnly: false },
  'reports.view': { label: 'See reports', description: 'See run history and insights', workspaceOnly: false },
  export: { label: 'Export', description: 'Download answers as CSV', workspaceOnly: false },
  'settings.manage': { label: 'Manage settings', description: 'Change workspace settings, verify the setup and delete history', workspaceOnly: true },
  'sso.manage': { label: 'Manage sign-in', description: 'Change Google sign-in, SAML and token sign-in', workspaceOnly: true },
  'tokens.manage': { label: 'Manage tokens', description: 'Machine tokens, service MCP tokens, and everyone’s MCP tokens and activity', workspaceOnly: true },
  'roles.manage': { label: 'Manage roles', description: 'Create roles and grant or revoke them', workspaceOnly: true },
} as const;

export type Permission = keyof typeof PERMISSIONS;

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
 * A person's access: workspace admins hold everything; otherwise Member on
 * each roster they are on and Manager on each standup they administer.
 */
export async function resolveAccess(repo: Repo, userName: string | null, workspaceAdmin: boolean): Promise<Access> {
  if (workspaceAdmin) return { workspace: new Set(BUILT_IN_ROLES.admin.permissions), standups: new Map() };
  const standups = new Map<number, Set<Permission>>();
  const grant = (id: number, permissions: Permission[]) => {
    const held = standups.get(id) ?? new Set<Permission>();
    for (const p of permissions) held.add(p);
    standups.set(id, held);
  };
  if (userName) {
    for (const s of await repo.listStandupsForUser(userName)) grant(s.id, BUILT_IN_ROLES.member.permissions);
    for (const s of await repo.listStandupsAdministeredBy(userName)) grant(s.id, BUILT_IN_ROLES.manager.permissions);
  }
  return { workspace: new Set(), standups };
}
