import { z } from 'zod';
import type { Permission } from '../../core/permission-catalogue.js';
import * as S from './schemas.js';

/** Who may call a route; the OpenAPI document turns this into security and a note. */
export type Access = 'public' | 'any' | 'person' | 'manager' | 'admin';

export interface RouteSpec {
  method: 'get' | 'post' | 'patch' | 'delete';
  /** Express form, relative to /api/v1. */
  path: string;
  summary: string;
  tag: string;
  access: Access;
  /** What the caller must hold, across the workspace or on the standup concerned. */
  permission?: Permission;
  params?: Record<string, { schema: z.ZodType; description: string }>;
  query?: Record<string, { schema: z.ZodType; description: string }>;
  body?: z.ZodType;
  /** Success responses: a schema, 'csv', or null for an empty 204. */
  responses: Record<number, z.ZodType | 'csv' | null>;
  /** Error statuses this route answers with the Error shape, beyond the ones every authenticated route has. */
  errors?: number[];
}

/** Every authenticated route can answer these. */
export const COMMON_ERRORS = [401, 403, 429];

const standupId = { id: { schema: z.number().int().positive(), description: 'Standup id' } };
const blockerId = { id: { schema: z.number().int().positive(), description: 'Blocker id' } };
const userNameParam = { userName: { schema: z.string(), description: 'Chat user resource name, URL-encoded (users%2F123)' } };
const dateParam = { date: { schema: z.iso.date(), description: 'YYYY-MM-DD' } };

export const ROUTES: RouteSpec[] = [
  { method: 'get', path: '/openapi.json', summary: 'This OpenAPI document', tag: 'Meta', access: 'public', responses: { 200: z.record(z.string(), z.unknown()) } },
  { method: 'get', path: '/auth/methods', summary: 'Which sign-in methods are switched on', tag: 'Meta', access: 'public', responses: { 200: S.AuthMethods } },
  { method: 'get', path: '/me', summary: 'The caller and their role', tag: 'Meta', access: 'any', responses: { 200: S.Me } },

  // standups
  { method: 'get', path: '/standups', summary: 'Standups the caller can see', tag: 'Standups', access: 'any', responses: { 200: S.StandupList } },
  { method: 'post', path: '/standups', summary: 'Create a standup', tag: 'Standups', access: 'admin', permission: 'standups.create', body: S.CreateStandup, responses: { 201: S.CreatedStandup }, errors: [400, 409] },
  { method: 'get', path: '/standups/:id', summary: 'One standup with its roster and admins', tag: 'Standups', access: 'any', permission: 'standups.view', params: standupId, responses: { 200: S.StandupDetail }, errors: [404] },
  { method: 'patch', path: '/standups/:id', summary: 'Change a standup’s settings', tag: 'Standups', access: 'manager', permission: 'standups.configure', params: standupId, body: S.StandupPatch, responses: { 200: S.StandupSummary }, errors: [400, 404] },
  {
    method: 'delete',
    path: '/standups/:id',
    summary: 'Delete an archived standup and all its history',
    tag: 'Standups',
    access: 'admin', permission: 'standups.delete',
    params: standupId,
    body: S.DeleteStandupBody,
    responses: { 200: S.DeletedHistory },
    errors: [400, 404, 409],
  },
  { method: 'post', path: '/standups/:id/archive', summary: 'Archive a standup', tag: 'Standups', access: 'manager', permission: 'standups.archive', params: standupId, responses: { 200: S.ArchiveResult }, errors: [404] },
  { method: 'post', path: '/standups/:id/unarchive', summary: 'Bring an archived standup back', tag: 'Standups', access: 'manager', permission: 'standups.archive', params: standupId, responses: { 200: S.ArchiveResult }, errors: [404] },
  { method: 'post', path: '/standups/:id/run-now', summary: 'Start today’s run now', tag: 'Standups', access: 'manager', permission: 'standups.configure', params: standupId, responses: { 200: S.RunNow }, errors: [404] },
  { method: 'post', path: '/standups/:id/nudge', summary: 'Remind everyone still expected today', tag: 'Standups', access: 'manager', permission: 'standups.configure', params: standupId, responses: { 200: S.Nudged }, errors: [404, 409] },
  {
    method: 'get',
    path: '/standups/:id/runs',
    summary: 'Recent runs',
    tag: 'Runs',
    access: 'any', permission: 'reports.view',
    params: standupId,
    query: { limit: { schema: z.number().int().min(1).max(90).default(14), description: 'How many runs, newest first' } },
    responses: { 200: S.RunList },
    errors: [404],
  },
  { method: 'get', path: '/standups/:id/runs/today', summary: 'Today’s run, for polling', tag: 'Runs', access: 'any', permission: 'standups.view', params: standupId, responses: { 200: S.TodayRun }, errors: [404] },
  { method: 'get', path: '/standups/:id/runs/:date', summary: 'One day’s run with every submission', tag: 'Runs', access: 'any', permission: 'answers.view', params: { ...standupId, ...dateParam }, responses: { 200: S.RunDetail }, errors: [400, 404] },
  {
    method: 'get',
    path: '/standups/:id/insights',
    summary: 'Weekly participation, mood and blocker trends',
    tag: 'Runs',
    access: 'any', permission: 'reports.view',
    params: standupId,
    query: { weeks: { schema: z.number().int().min(1).max(26).default(8), description: 'How many weeks back' } },
    responses: { 200: S.Insights },
    errors: [404],
  },
  {
    method: 'get',
    path: '/standups/:id/export.csv',
    summary: 'Submissions as CSV',
    tag: 'Runs',
    access: 'manager', permission: 'export',
    params: standupId,
    query: { days: { schema: z.number().int().min(1).max(365).default(90), description: 'How many days back' } },
    responses: { 200: 'csv' },
    errors: [404],
  },
  { method: 'get', path: '/standups/:id/webhook/secret', summary: 'The key this standup’s webhooks are signed with', tag: 'Standups', access: 'manager', permission: 'standups.configure', params: standupId, responses: { 200: S.WebhookSecret }, errors: [403, 404, 503] },
  { method: 'get', path: '/standups/:id/members', summary: 'Members of the standup’s Chat space, as roster candidates', tag: 'Roster', access: 'manager', permission: 'people.manage', params: standupId, responses: { 200: S.SpaceMembers }, errors: [404, 502] },
  { method: 'post', path: '/standups/:id/roster/sync', summary: 'Sync the roster with its Google Group, or with its Chat space, now', tag: 'Roster', access: 'manager', permission: 'people.manage', params: standupId, responses: { 200: S.RosterSynced }, errors: [404, 502, 503] },
  { method: 'post', path: '/standups/:id/participants', summary: 'Add someone to the roster', tag: 'Roster', access: 'manager', permission: 'people.manage', params: standupId, body: S.AddParticipant, responses: { 201: S.AddedParticipant }, errors: [400, 404] },
  {
    method: 'patch',
    path: '/standups/:id/participants/:userName',
    summary: 'Change someone’s role on the roster',
    tag: 'Roster',
    access: 'manager', permission: 'people.manage',
    params: { ...standupId, ...userNameParam },
    body: S.UpdateParticipant,
    responses: { 200: S.UpdatedParticipant },
    errors: [400, 404, 409],
  },
  { method: 'delete', path: '/standups/:id/participants/:userName', summary: 'Remove someone from the roster', tag: 'Roster', access: 'manager', permission: 'people.manage', params: { ...standupId, ...userNameParam }, responses: { 204: null }, errors: [404] },

  // blockers and people
  {
    method: 'get',
    path: '/blockers',
    summary: 'Blockers across the standups the caller can see',
    tag: 'Blockers',
    access: 'any', permission: 'blockers.view',
    query: {
      status: { schema: z.enum(['open', 'acknowledged', 'resolved', 'all']).default('open'), description: 'Which blockers' },
      standupId: { schema: z.number().int().positive(), description: 'One standup only' },
      owner: { schema: z.string(), description: 'Owner’s userName' },
    },
    responses: { 200: S.BlockerList },
    errors: [400],
  },
  { method: 'post', path: '/blockers/:id/acknowledge', summary: 'Acknowledge a blocker you are tagged on', tag: 'Blockers', access: 'person', params: blockerId, responses: { 200: S.BlockerResult.acknowledge }, errors: [404, 409] },
  { method: 'post', path: '/blockers/:id/update', summary: 'Add an update to a blocker', tag: 'Blockers', access: 'person', params: blockerId, body: S.BlockerUpdateBody, responses: { 200: S.BlockerResult.update }, errors: [400, 404, 409] },
  { method: 'post', path: '/blockers/:id/resolve', summary: 'Resolve a blocker', tag: 'Blockers', access: 'person', params: blockerId, responses: { 200: S.BlockerResult.resolve }, errors: [404, 409] },
  { method: 'get', path: '/people', summary: 'Everyone on the rosters the caller manages', tag: 'People', access: 'manager', permission: 'people.view', responses: { 200: S.Team } },

  // create-standup helpers
  { method: 'get', path: '/templates', summary: 'Standup templates', tag: 'Standups', access: 'any', responses: { 200: S.Templates } },
  { method: 'get', path: '/spaces', summary: 'Chat spaces the app is in', tag: 'Standups', access: 'admin', permission: 'standups.create', responses: { 200: S.Spaces }, errors: [502] },
  {
    method: 'get',
    path: '/spaces/:name/members',
    summary: 'Human members of a Chat space',
    tag: 'Standups',
    access: 'admin', permission: 'standups.create',
    params: { name: { schema: z.string(), description: 'Space resource name, URL-encoded (spaces%2FAAAA)' } },
    responses: { 200: S.SpaceMembers },
    errors: [400, 502],
  },

  // the caller's own view
  { method: 'get', path: '/me/standups', summary: 'My standups and how today is going', tag: 'Me', access: 'any', responses: { 200: S.MyStandups } },
  {
    method: 'get',
    path: '/me/submissions',
    summary: 'My recent answers',
    tag: 'Me',
    access: 'any',
    query: { limit: { schema: z.number().int().min(1).max(50).default(10), description: 'How many, newest first' } },
    responses: { 200: S.MySubmissions },
  },
  { method: 'post', path: '/me/skip', summary: 'Skip today for one standup', tag: 'Me', access: 'person', body: S.SkipBody, responses: { 200: S.Skipped }, errors: [400, 404, 409, 503] },
  { method: 'patch', path: '/me', summary: 'My timezone and vacation', tag: 'Me', access: 'person', body: S.MyPatch, responses: { 200: S.MySettings }, errors: [400, 409] },

  // schedules
  { method: 'get', path: '/me/schedule', summary: 'My days on each standup, policies and upcoming days', tag: 'Schedules', access: 'person', responses: { 200: S.Schedule }, errors: [409, 503] },
  { method: 'patch', path: '/me/schedule', summary: 'Set my days on a standup', tag: 'Schedules', access: 'person', body: S.WorkingDaysBody, responses: { 200: S.Schedule }, errors: [400, 409, 503] },
  { method: 'post', path: '/me/overrides', summary: 'Mark my days off or extra working days', tag: 'Schedules', access: 'person', body: S.OverrideBody, responses: { 200: S.ScheduleChange }, errors: [400, 409, 503] },
  { method: 'delete', path: '/me/overrides/:date', summary: 'Withdraw a day or a pending request', tag: 'Schedules', access: 'person', params: dateParam, responses: { 200: S.ScheduleChange }, errors: [400, 409, 503] },
  { method: 'get', path: '/people/:userName/schedule', summary: 'Someone’s days and upcoming days', tag: 'Schedules', access: 'manager', permission: 'schedules.manage', params: userNameParam, responses: { 200: S.Schedule }, errors: [503] },
  { method: 'patch', path: '/people/:userName/schedule', summary: 'Set someone’s days on a standup', tag: 'Schedules', access: 'manager', permission: 'schedules.manage', params: userNameParam, body: S.WorkingDaysBody, responses: { 200: S.Schedule }, errors: [400, 503] },
  { method: 'post', path: '/people/:userName/overrides', summary: 'Mark someone’s days off or extra working days', tag: 'Schedules', access: 'manager', permission: 'schedules.manage', params: userNameParam, body: S.OverrideBody, responses: { 200: S.ScheduleChange }, errors: [400, 503] },
  { method: 'delete', path: '/people/:userName/overrides/:date', summary: 'Withdraw someone’s day', tag: 'Schedules', access: 'manager', permission: 'schedules.manage', params: { ...userNameParam, ...dateParam }, responses: { 200: S.ScheduleChange }, errors: [400, 503] },
  { method: 'get', path: '/requests', summary: 'Time-off requests waiting for a decision', tag: 'Schedules', access: 'manager', permission: 'schedules.manage', responses: { 200: S.TimeOffRequests }, errors: [503] },
  {
    method: 'post',
    path: '/requests/:id/approve',
    summary: 'Approve a request',
    tag: 'Schedules',
    access: 'manager', permission: 'schedules.manage',
    params: { id: { schema: z.string(), description: 'Request ids, comma-separated (one request can span several dates)' } },
    body: S.DecisionBody,
    responses: { 200: S.Decision },
    errors: [409, 503],
  },
  {
    method: 'post',
    path: '/requests/:id/decline',
    summary: 'Decline a request',
    tag: 'Schedules',
    access: 'manager', permission: 'schedules.manage',
    params: { id: { schema: z.string(), description: 'Request ids, comma-separated' } },
    body: S.DecisionBody,
    responses: { 200: S.Decision },
    errors: [409, 503],
  },

  // asking to edit answers after the deadline
  { method: 'get', path: '/edit-requests', summary: 'Requests to edit answers after the deadline, waiting for a decision', tag: 'Runs', access: 'manager', permission: 'standups.configure', responses: { 200: S.EditRequests }, errors: [503] },
  ...(['approve', 'decline'] as const).map((decision) => ({
    method: 'post' as const,
    path: `/edit-requests/:id/${decision}`,
    summary: decision === 'approve' ? 'Let someone edit their answers until midnight' : 'Decline a request to edit answers',
    tag: 'Runs',
    access: 'manager' as const,
    permission: 'standups.configure' as const,
    params: { id: { schema: z.string(), description: 'Edit request id' } },
    body: S.DecisionBody,
    responses: { 200: S.Decision },
    errors: [404, 409, 503],
  })),

  // settings
  { method: 'get', path: '/settings', summary: 'Workspace settings', tag: 'Settings', access: 'admin', permission: 'settings.manage', responses: { 200: S.Settings } },
  { method: 'patch', path: '/settings', summary: 'Change workspace settings', tag: 'Settings', access: 'admin', permission: 'settings.manage', body: S.SettingsPatch, responses: { 200: S.Settings }, errors: [400, 409] },
  { method: 'delete', path: '/history', summary: 'Delete every run, submission, blocker and poll', tag: 'Settings', access: 'admin', permission: 'settings.manage', body: S.DeleteHistoryBody, responses: { 200: S.DeletedHistory }, errors: [400] },
  {
    method: 'post',
    path: '/settings/tokens/:name',
    summary: 'Generate a machine token',
    tag: 'Settings',
    access: 'admin', permission: 'tokens.manage',
    params: { name: { schema: z.enum(['tick', 'export', 'scim']), description: 'Which token' } },
    responses: { 201: S.GeneratedToken },
    errors: [404],
  },
  {
    method: 'delete',
    path: '/settings/tokens/:name',
    summary: 'Revoke a machine token',
    tag: 'Settings',
    access: 'admin', permission: 'tokens.manage',
    params: { name: { schema: z.enum(['tick', 'export', 'scim']), description: 'Which token' } },
    responses: { 204: null },
    errors: [404],
  },
  { method: 'post', path: '/verify/project', summary: 'Check the Google Cloud project number', tag: 'Verify', access: 'admin', permission: 'settings.manage', responses: { 200: S.Verification } },
  { method: 'post', path: '/verify/service-account', summary: 'Check the service account against the Chat API', tag: 'Verify', access: 'admin', permission: 'settings.manage', responses: { 200: S.Verification } },
  { method: 'post', path: '/verify/chat-event', summary: 'Check that Chat events are arriving', tag: 'Verify', access: 'admin', permission: 'settings.manage', responses: { 200: S.Verification } },
  { method: 'post', path: '/verify/webhook', summary: 'Send a signed test event to a standup’s webhook', tag: 'Verify', access: 'manager', permission: 'standups.configure', body: S.VerifyWebhookBody, responses: { 200: S.Verification }, errors: [404] },
  { method: 'post', path: '/verify/saml', summary: 'Check the SAML identity provider', tag: 'Verify', access: 'admin', permission: 'sso.manage', responses: { 200: S.Verification } },
  { method: 'post', path: '/verify/dm', summary: 'Send the caller a test DM', tag: 'Verify', access: 'person', responses: { 200: S.Verification } },

  // MCP
  { method: 'get', path: '/mcp/tokens', summary: 'MCP tokens (admins see all, others their own)', tag: 'MCP', access: 'any', responses: { 200: S.McpTokens } },
  { method: 'post', path: '/mcp/tokens', summary: 'Create an MCP token', tag: 'MCP', access: 'any', body: S.CreateMcpTokenBody, responses: { 201: S.CreatedMcpToken }, errors: [400] },
  { method: 'delete', path: '/mcp/tokens/:id', summary: 'Revoke an MCP token', tag: 'MCP', access: 'any', params: { id: { schema: z.number().int().positive(), description: 'Token id' } }, responses: { 204: null }, errors: [404] },
  {
    method: 'get',
    path: '/mcp/activity',
    summary: 'Recent MCP tool calls',
    tag: 'MCP',
    access: 'any',
    query: { limit: { schema: z.number().int().min(1).max(500).default(50), description: 'How many, newest first' } },
    responses: { 200: S.McpActivity },
  },
  // roles and grants
  { method: 'get', path: '/permissions', summary: 'Every permission a role can hold', tag: 'Roles', access: 'any', responses: { 200: S.PermissionList } },
  { method: 'get', path: '/roles', summary: 'Built-in and custom roles, with how many hold each', tag: 'Roles', access: 'manager', permission: 'people.manage', responses: { 200: S.RoleList } },
  { method: 'post', path: '/roles', summary: 'Create a role', tag: 'Roles', access: 'admin', permission: 'roles.manage', body: S.RoleBody, responses: { 201: S.Role }, errors: [400, 409] },
  { method: 'patch', path: '/roles/:id', summary: 'Change a custom role', tag: 'Roles', access: 'admin', permission: 'roles.manage', params: { id: { schema: z.string(), description: 'Role id' } }, body: S.RoleBody, responses: { 200: S.Role }, errors: [400, 404, 409] },
  { method: 'delete', path: '/roles/:id', summary: 'Delete a custom role nobody holds', tag: 'Roles', access: 'admin', permission: 'roles.manage', params: { id: { schema: z.string(), description: 'Role id' } }, responses: { 204: null }, errors: [400, 404, 409] },
  {
    method: 'get',
    path: '/grants',
    summary: 'Who holds which role, where the caller can grant',
    tag: 'Roles',
    access: 'manager',
    permission: 'people.manage',
    query: { standupId: { schema: z.number().int().positive(), description: 'Only grants on this standup' } },
    responses: { 200: S.GrantList },
  },
  { method: 'post', path: '/grants', summary: 'Grant a role across the workspace or on one standup', tag: 'Roles', access: 'manager', permission: 'people.manage', body: S.GrantBody, responses: { 201: S.Grant }, errors: [400, 404, 409] },
  { method: 'delete', path: '/grants/:id', summary: 'Revoke a grant', tag: 'Roles', access: 'manager', permission: 'people.manage', params: { id: { schema: z.number().int().positive(), description: 'Grant id' } }, responses: { 204: null }, errors: [404, 409] },
  {
    method: 'get',
    path: '/roles/audit',
    summary: 'Every change to roles and grants',
    tag: 'Roles',
    access: 'admin',
    permission: 'roles.manage',
    query: { limit: { schema: z.number().int().min(1).max(500).default(100), description: 'How many, newest first' } },
    responses: { 200: S.RoleAudit },
  },
  { method: 'post', path: '/verify/mcp', summary: 'Check the MCP server is on and has tokens', tag: 'Verify', access: 'admin', permission: 'settings.manage', responses: { 200: S.Verification } },
];

/** Looks up a route by method and Express path. */
export function findRoute(method: string, path: string): RouteSpec | undefined {
  const m = method.toLowerCase();
  return ROUTES.find((r) => r.method === m && r.path === path);
}
