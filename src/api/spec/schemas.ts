import { z } from 'zod';
import { MCP_SCOPES } from '../../core/mcp-scopes.js';
import { AWAY_REASONS, MOODS, OVERRIDE_STATUSES, TIME_OFF_POLICIES, WEEKDAYS } from '../../core/types.js';

/**
 * The JSON API's request and response shapes. They generate the OpenAPI
 * document, give the web app its types, and in tests every response (and
 * every accepted request) is checked against them, so the spec cannot drift
 * from what the server does. The web app reads this file for its types, so
 * it only imports zod and dependency-free constant modules.
 */
export const registry = z.registry<{ id?: string; description?: string }>();

function named<T extends z.ZodType>(id: string, schema: T, description?: string): T {
  registry.add(schema as z.ZodType, { id, ...(description ? { description } : {}) });
  return schema;
}

const id = z.number().int().positive();
const count = z.number().int().nonnegative();
const date = z.iso.date();
const timestamp = z.iso.datetime({ offset: true });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const text = z.string().max(200);

export const Mood = named('Mood', z.enum(MOODS));
export const Weekday = named('Weekday', z.enum(WEEKDAYS));
export const TimeOffPolicy = named('TimeOffPolicy', z.enum(TIME_OFF_POLICIES), 'self: people mark themselves away · approval: a manager must approve · managers: only managers can.');
export const McpScope = named('McpScope', z.enum(MCP_SCOPES));

export const ApiError = named(
  'Error',
  z.strictObject({ error: z.strictObject({ code: z.string(), message: z.string(), field: z.string().optional() }) }),
  'Every error has this shape; `field` names the input at fault when there is one.',
);

export const Person = named('Person', z.strictObject({ userName: z.string(), displayName: z.string() }), 'A Google Chat user (`users/…`) and their display name.');

export const AuthMethods = named('AuthMethods', z.strictObject({ google: z.boolean(), saml: z.boolean(), token: z.boolean() }));

export const Me = named(
  'Me',
  z.strictObject({
    kind: z.enum(['admin', 'manager', 'member']),
    via: z.enum(['session', 'token']),
    tenantId: z.string(),
    user: z.strictObject({ userName: z.string().nullable(), email: z.string(), name: z.string() }).nullable(),
    managedStandupIds: z.array(id),
  }),
  'The caller. `user` is null for the operator token.',
);

// --- standups and runs

export const StandupSummary = named(
  'StandupSummary',
  z.strictObject({
    id,
    name: z.string(),
    spaceName: z.string(),
    active: z.boolean(),
    schedule: z.strictObject({
      promptTime: time,
      deadlineTime: time,
      timezone: z.string(),
      days: z.array(Weekday),
      reminderMinutesBefore: count,
    }),
    questions: z.array(z.string()),
    mood: z.strictObject({ enabled: z.boolean(), anonymous: z.boolean() }),
    digestEnabled: z.boolean(),
    timeOffPolicy: TimeOffPolicy,
    escalation: z.strictObject({
      afterDays: count,
      contact: z.strictObject({ userName: z.string(), displayName: z.string().nullable() }).nullable(),
    }),
    webhook: z.strictObject({ configured: z.boolean() }),
    people: z.strictObject({ total: count, mandatory: count }),
    today: z.strictObject({
      date,
      status: z.enum(['open', 'closed']).nullable(),
      submitted: count,
      expected: count,
      missing: z.array(Person),
    }),
    permissions: z.strictObject({ manage: z.boolean() }),
  }),
);

export const StandupList = named('StandupList', z.strictObject({ standups: z.array(StandupSummary) }));

export const StandupDetail = named(
  'StandupDetail',
  StandupSummary.extend({
    participants: z.array(
      z.strictObject({ userName: z.string(), displayName: z.string(), mandatory: z.boolean(), timezone: z.string().nullable(), onVacation: z.boolean() }),
    ),
    admins: z.array(Person),
  }),
);

export const RunNowResult = named('RunNowResult', z.enum(['started', 'already_open', 'already_closed', 'no_participants']));

export const CreatedStandup = named(
  'CreatedStandup',
  StandupDetail.extend({ template: z.string().nullable(), runNow: RunNowResult.nullable() }),
  'The new standup; `runNow` is set when the request asked to start today’s run.',
);

export const ArchiveResult = named('ArchiveResult', z.strictObject({ id, active: z.boolean() }));
export const RunNow = named('RunNow', z.strictObject({ result: RunNowResult }));
export const Nudged = named('Nudged', z.strictObject({ nudged: z.array(Person) }));

export const RunListItem = named(
  'RunListItem',
  z.strictObject({ date, status: z.enum(['open', 'closed']), submitted: count, expected: count, missing: z.array(Person) }),
);
export const RunList = named('RunList', z.strictObject({ runs: z.array(RunListItem) }));

export const AwayReason = named('AwayReason', z.enum(AWAY_REASONS));

export const TodayRun = named(
  'TodayRun',
  z.strictObject({
    date,
    status: z.enum(['open', 'closed']).nullable(),
    expected: count,
    submitted: z.array(z.strictObject({ userName: z.string(), displayName: z.string(), submittedAt: timestamp, late: z.boolean(), mood: Mood.nullable() })),
    waiting: z.array(z.strictObject({ userName: z.string(), displayName: z.string(), mandatory: z.boolean(), remindedAt: timestamp.nullable() })),
    away: z.array(z.strictObject({ userName: z.string(), displayName: z.string(), reason: AwayReason, reasonLabel: z.string() })),
    teamMood: z.number().nullable(),
  }),
  'Today’s run for polling. `status` is null before the run opens; `teamMood` is only set when moods are anonymous.',
);

export const Answer = named('Answer', z.strictObject({ question: z.string(), answer: z.string() }));

export const Submission = named(
  'Submission',
  z.strictObject({
    userName: z.string(),
    displayName: z.string(),
    submittedAt: timestamp,
    editedAt: timestamp.nullable(),
    late: z.boolean(),
    mood: Mood.nullable(),
    answers: z.array(Answer),
  }),
  '`mood` is null when the standup keeps moods anonymous.',
);

export const RunDetail = named(
  'RunDetail',
  z.strictObject({
    date,
    status: z.enum(['open', 'closed']),
    submitted: count,
    expected: count,
    missing: z.array(Person),
    submissions: z.array(Submission),
    teamMood: z.number().nullable(),
  }),
);

export const WeekPoint = named(
  'WeekPoint',
  z.strictObject({
    label: z.string(),
    participationPct: z.number().nullable(),
    mood: z.number().nullable(),
    blockersOpened: count,
    blockersResolved: count,
  }),
);
export const Insights = named('Insights', z.strictObject({ weeks: z.array(WeekPoint) }));

export const AddedParticipant = named(
  'AddedParticipant',
  z.strictObject({ userName: z.string(), displayName: z.string(), mandatory: z.boolean(), reachable: z.boolean() }),
  '`reachable` is false when the bot cannot DM the person yet.',
);
export const UpdatedParticipant = named(
  'UpdatedParticipant',
  z.strictObject({ userName: z.string(), displayName: z.string(), mandatory: z.boolean(), onVacation: z.boolean(), admin: z.boolean() }),
);

// --- blockers and people

export const Blocker = named(
  'Blocker',
  z.strictObject({
    id,
    standup: z.strictObject({ id, name: z.string() }),
    owner: Person,
    text: z.string(),
    openedDate: date,
    resolvedDate: date.nullable(),
    resolvedBy: z.string().nullable(),
    escalatedAt: timestamp.nullable(),
    status: z.enum(['open', 'acknowledged', 'resolved']),
    tags: z.array(z.strictObject({ userName: z.string(), displayName: z.string(), acknowledgedAt: timestamp.nullable() })),
    updates: z.array(z.strictObject({ userName: z.string(), displayName: z.string(), text: z.string(), at: timestamp })),
  }),
);
export const BlockerList = named('BlockerList', z.strictObject({ blockers: z.array(Blocker) }));

export const TeamMember = named(
  'TeamMember',
  z.strictObject({
    userName: z.string(),
    displayName: z.string(),
    email: z.string().nullable(),
    timezone: z.string().nullable(),
    onVacation: z.boolean(),
    workingDays: z.string().nullable(),
    workingDaysLabel: z.string(),
    standups: z.array(z.strictObject({ id, name: z.string(), mandatory: z.boolean(), admin: z.boolean() })),
  }),
);
export const Team = named('Team', z.strictObject({ people: z.array(TeamMember) }));

export const Template = named(
  'Template',
  z.strictObject({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    questions: z.array(z.string()).nullable(),
    days: z.array(Weekday),
    promptTime: time,
    deadlineTime: time,
    moodEnabled: z.boolean(),
    moodAnonymous: z.boolean(),
    digestEnabled: z.boolean(),
  }),
  '`questions` is null for templates that use the default questions.',
);
export const Templates = named('Templates', z.strictObject({ templates: z.array(Template) }));

export const Spaces = named(
  'Spaces',
  z.strictObject({ spaces: z.array(z.strictObject({ name: z.string(), displayName: z.string(), standups: z.array(z.strictObject({ id, name: z.string() })) })) }),
);
export const SpaceMembers = named('SpaceMembers', z.strictObject({ members: z.array(Person) }));

// --- the caller's own view

export const MyStandup = named('MyStandup', z.strictObject({
  id,
  name: z.string(),
  schedule: z.strictObject({ promptTime: time, deadlineTime: time, timezone: z.string(), days: z.array(Weekday) }),
  today: z.enum(['submitted', 'waiting', 'closed']).nullable(),
  progress: z.strictObject({ submitted: count, expected: count }).nullable(),
  mandatory: z.boolean(),
  onVacation: z.boolean(),
}));

export const LinkedMyStandups = named(
  'LinkedMyStandups',
  z.strictObject({ linked: z.literal(true), timezone: z.string().nullable(), chat: z.strictObject({ dmUrl: z.string().nullable() }), standups: z.array(MyStandup) }),
);

export const MyStandups = named(
  'MyStandups',
  z.union([z.strictObject({ linked: z.literal(false), standups: z.array(MyStandup).max(0) }), LinkedMyStandups]),
  '`linked` is false until the account is tied to a Google Chat identity.',
);

export const MySubmissions = named(
  'MySubmissions',
  z.strictObject({
    submissions: z.array(
      z.strictObject({
        date,
        standupName: z.string(),
        submittedAt: timestamp,
        editedAt: timestamp.nullable(),
        late: z.boolean(),
        mood: Mood.nullable(),
        answers: z.array(Answer),
      }),
    ),
  }),
);

export const Skipped = named('Skipped', z.strictObject({ result: z.literal('skipped'), date }));
export const MySettings = named('MySettings', z.strictObject({ timezone: z.string().nullable(), onVacation: z.boolean() }));

// --- schedules

export const Override = named(
  'Override',
  z.strictObject({
    id,
    userName: z.string(),
    displayName: z.string(),
    date,
    working: z.boolean(),
    reason: z.string(),
    status: z.enum(OVERRIDE_STATUSES),
    label: z.string(),
    setBy: z.string(),
    channel: z.enum(['chat', 'console', 'api']),
    decidedBy: z.string().nullable(),
    decisionNote: z.string().nullable(),
    createdAt: timestamp,
  }),
  'A dated day off or extra working day, and where it stands.',
);

export const Schedule = named(
  'Schedule',
  z.strictObject({
    userName: z.string(),
    displayName: z.string(),
    workingDays: z.string().nullable(),
    workingDaysLabel: z.string(),
    policies: z.array(z.strictObject({ standupId: id, name: z.string(), timeOffPolicy: TimeOffPolicy })),
    overrides: z.array(Override),
  }),
  '`workingDays` is null when the person follows the standup, `adhoc`, or a comma list of weekdays.',
);

export const ScheduleChange = named(
  'ScheduleChange',
  z.strictObject({ ok: z.literal(true), status: z.enum(['active', 'pending']), message: z.string() }),
  '`pending` means the change became a request for a manager to approve.',
);
export const TimeOffRequests = named('TimeOffRequests', z.strictObject({ requests: z.array(Override) }));
export const Decision = named('Decision', z.strictObject({ ok: z.literal(true), message: z.string() }));

// --- settings, verification and MCP

const secret = z.strictObject({ set: z.boolean() });

export const Settings = named(
  'Settings',
  z.strictObject({
    chat: z.strictObject({
      audience: z.string(),
      serviceAccount: z.strictObject({ set: z.boolean(), email: z.string().nullable(), clientId: z.string().nullable() }),
    }),
    workspace: z.strictObject({ defaultTimezone: z.string(), calendarOoo: z.boolean(), workspaceAdminEmail: z.string() }),
    signIn: z.strictObject({
      tokenSignIn: z.boolean(),
      google: z.strictObject({ clientId: z.string(), clientSecret: secret, on: z.boolean() }),
      saml: z.strictObject({
        entityId: z.string(),
        ssoUrl: z.string(),
        cert: secret,
        adminAttribute: z.string(),
        adminGroup: z.string(),
        on: z.boolean(),
      }),
    }),
    tokens: z.strictObject({ tick: secret, export: secret, scim: secret }),
    setup: z.strictObject({ complete: z.boolean(), chatConfigured: z.boolean(), signInConfigured: z.boolean() }),
    mcp: z.strictObject({
      enabled: z.boolean(),
      defaultScopes: z.array(McpScope),
      endpoint: z.string(),
      scopes: z.record(McpScope, z.string()),
    }),
  }),
  'Workspace settings. Secrets are never returned, only whether they are set.',
);

export const DeletedHistory = named(
  'DeletedHistory',
  z.strictObject({ deleted: z.strictObject({ runs: count, submissions: count, blockers: count, polls: count }) }),
);
export const GeneratedToken = named('GeneratedToken', z.strictObject({ name: z.enum(['tick', 'export', 'scim']), token: z.string() }), 'Shown once.');

export const Verification = named(
  'Verification',
  z.strictObject({ state: z.enum(['pass', 'fail']), detail: z.string(), checkedAt: timestamp, data: z.record(z.string(), z.unknown()).optional() }),
);

export const McpToken = named(
  'McpToken',
  z.strictObject({
    id,
    name: z.string(),
    kind: z.enum(['personal', 'service']),
    owner: z.strictObject({ userName: z.string(), displayName: z.string().nullable() }).nullable(),
    scopes: z.array(McpScope),
    createdAt: timestamp,
    lastUsedAt: timestamp.nullable(),
    expiresAt: timestamp,
    revokedAt: timestamp.nullable(),
  }),
);
export const McpTokens = named('McpTokens', z.strictObject({ tokens: z.array(McpToken) }));
export const CreatedMcpToken = named(
  'CreatedMcpToken',
  McpToken.extend({
    secret: z.string(),
    config: z.strictObject({ url: z.string(), headers: z.strictObject({ Authorization: z.string() }) }),
  }),
  'The secret is shown once; `config` is ready to paste into an MCP client.',
);
export const McpActivity = named(
  'McpActivity',
  z.strictObject({
    activity: z.array(
      z.strictObject({ id, token: z.strictObject({ id, name: z.string() }), tool: z.string(), argsSummary: z.string(), ok: z.boolean(), at: timestamp }),
    ),
  }),
);

export const BlockerResult = {
  acknowledge: named('BlockerAcknowledged', z.strictObject({ result: z.literal('acked') })),
  update: named('BlockerUpdated', z.strictObject({ result: z.literal('ok') })),
  resolve: named('BlockerResolved', z.strictObject({ result: z.literal('resolved') })),
};

// --- request bodies

const standupConfigFields = {
  name: z.string().min(1),
  promptTime: time,
  deadlineTime: time,
  timezone: z.string().describe('IANA timezone, e.g. Asia/Kolkata'),
  reminderMinutesBefore: z.number().int().min(0).max(24 * 60),
  escalateAfterDays: z.number().int().min(1).max(30),
  days: z.union([z.array(Weekday), z.string()]).describe('["mon","tue"] or "mon,tue"'),
  webhookUrl: z.string().nullable().describe('https:// URL; empty or null switches the webhook off'),
  questions: z.array(text).min(1).max(10),
  moodEnabled: z.boolean(),
  moodAnonymous: z.boolean(),
  digestEnabled: z.boolean(),
  timeOffPolicy: TimeOffPolicy,
  escalateUserName: z.string().nullable().describe('A participant’s userName; empty or null switches escalation off'),
};

export const StandupPatch = named('StandupPatch', z.strictObject(standupConfigFields).partial(), 'Any subset of the standup’s settings.');

const rosterEntry = z.strictObject({ userName: z.string().startsWith('users/'), displayName: text.min(1), mandatory: z.boolean().optional() });

export const CreateStandup = named(
  'CreateStandup',
  z
    .strictObject(standupConfigFields)
    .partial()
    .extend({
      name: z.string().min(1),
      spaceName: z.string().startsWith('spaces/'),
      templateId: z.string().nullable().optional(),
      participants: z.array(rosterEntry).optional(),
      admins: z.array(rosterEntry.omit({ mandatory: true })).optional(),
      runNow: z.boolean().optional(),
    }),
  'A template fills anything left out; explicit fields win.',
);

export const AddParticipant = named('AddParticipant', z.strictObject({ userName: z.string().startsWith('users/'), displayName: text.min(1), mandatory: z.boolean().optional() }));
export const UpdateParticipant = named('UpdateParticipant', z.strictObject({ mandatory: z.boolean(), onVacation: z.boolean(), admin: z.boolean() }).partial());
export const BlockerUpdateBody = named('BlockerUpdateBody', z.strictObject({ text: text.min(1) }));
export const SkipBody = named('SkipBody', z.strictObject({ standupId: id }));
export const MyPatch = named('MyPatch', z.strictObject({ timezone: z.string().nullable(), onVacation: z.boolean() }).partial(), 'A null or empty timezone follows the standups’ zones again.');
export const WorkingDaysBody = named('WorkingDaysBody', z.strictObject({ workingDays: z.string().optional() }), '"mon-thu", "mon,wed,fri", "adhoc", or "reset" (the default) to follow the standup.');
export const OverrideBody = named(
  'OverrideBody',
  z.strictObject({
    date: date.optional(),
    dates: z.array(date).max(31).optional(),
    from: date.optional(),
    to: date.optional(),
    working: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  'Give `date`, `dates` or `from` and `to` (at most 31 days). `working: true` marks extra working days instead of days off; the reason is cut to 200 characters.',
);
export const DecisionBody = named('DecisionBody', z.strictObject({ note: z.string().optional() }), 'A decline note is sent to the person.');

export const SettingsPatch = named(
  'SettingsPatch',
  z
    .strictObject({
      calendarOoo: z.boolean(),
      tokenSignIn: z.boolean(),
      setupComplete: z.boolean(),
      mcpEnabled: z.boolean(),
      chatAudience: z.string(),
      serviceAccountJson: z.string().nullable(),
      defaultTimezone: z.string(),
      workspaceAdminEmail: z.string(),
      oauthClientId: z.string(),
      oauthClientSecret: z.string().nullable(),
      samlIdpEntityId: z.string(),
      samlIdpSsoUrl: z.string(),
      samlIdpCert: z.string(),
      samlAdminAttribute: z.string(),
      samlAdminGroup: z.string(),
      mcpDefaultScopes: z.string(),
    })
    .partial(),
  'Any subset of settings. Secrets keep their value on an empty string and clear on null.',
);
export const DeleteHistoryBody = named('DeleteHistoryBody', z.strictObject({ confirm: z.literal('DELETE HISTORY') }));
export const VerifyWebhookBody = named('VerifyWebhookBody', z.strictObject({ standupId: id }));
export const CreateMcpTokenBody = named(
  'CreateMcpTokenBody',
  z.strictObject({ name: text.min(1), kind: z.enum(['personal', 'service']).optional(), scopes: z.array(McpScope).optional() }),
  'Service tokens are admin-only and always read-only; scopes default to the workspace default.',
);

export type Person = z.infer<typeof Person>;
export type Mood = z.infer<typeof Mood>;
export type AwayReason = z.infer<typeof AwayReason>;
export type TimeOffPolicy = z.infer<typeof TimeOffPolicy>;
export type McpScope = z.infer<typeof McpScope>;
export type StandupSummary = z.infer<typeof StandupSummary>;
export type StandupDetail = z.infer<typeof StandupDetail>;
export type CreatedStandup = z.infer<typeof CreatedStandup>;
export type RunListItem = z.infer<typeof RunListItem>;
export type TodayRun = z.infer<typeof TodayRun>;
export type RunDetail = z.infer<typeof RunDetail>;
export type WeekPoint = z.infer<typeof WeekPoint>;
export type Blocker = z.infer<typeof Blocker>;
export type TeamMember = z.infer<typeof TeamMember>;
export type Template = z.infer<typeof Template>;
export type MyStandups = z.infer<typeof MyStandups>;
export type Override = z.infer<typeof Override>;
export type Schedule = z.infer<typeof Schedule>;
export type Settings = z.infer<typeof Settings>;
export type Verification = z.infer<typeof Verification>;
export type McpToken = z.infer<typeof McpToken>;
export type CreatedMcpToken = z.infer<typeof CreatedMcpToken>;
export type McpActivityEntry = z.infer<typeof McpActivity>['activity'][number];
export type Me = z.infer<typeof Me>;
export type AuthMethods = z.infer<typeof AuthMethods>;
