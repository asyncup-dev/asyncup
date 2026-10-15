/**
 * What a person may do. Roles are named sets of these; a grant gives a role
 * to someone across the workspace or on one standup. Dependency-free: the
 * web app reads it through the API schemas.
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
  'moods.comments': { label: 'Read mood comments', description: 'Read why people chose their mood. Names are hidden on standups that keep moods anonymous', workspaceOnly: false },
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
