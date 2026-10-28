import { z } from 'zod';
import { QUESTION_TYPES, RESULTS_VISIBILITY } from '../../core/poll-types.js';
import { MCP_SCOPES } from '../../core/mcp-scopes.js';
import { PERMISSIONS } from '../../core/permission-catalogue.js';
import { AWAY_REASONS, MOODS, OVERRIDE_STATUSES, TIME_OFF_POLICIES, WEEKDAYS } from '../../core/types.js';
import { LIMITS } from '../../core/validation.js';

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
export const Permission = named('Permission', z.enum(Object.keys(PERMISSIONS) as [keyof typeof PERMISSIONS, ...(keyof typeof PERMISSIONS)[]]));

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
    permissions: z.strictObject({ workspace: z.array(Permission), standups: z.record(z.string(), z.array(Permission)) }),
  }),
  'The caller. `user` is null for the operator token. `permissions.standups` is keyed by standup id and adds to the workspace ones.',
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
    roster: z
      .strictObject({ group: z.string().nullable(), syncedAt: timestamp.nullable(), error: z.string().nullable() })
      .describe('`group` is the Google Group the roster follows, or null when people are added by hand.'),
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
      z.strictObject({
        userName: z.string(),
        displayName: z.string(),
        mandatory: z.boolean(),
        timezone: z.string().nullable(),
        onVacation: z.boolean(),
        workingDays: z.string().nullable(),
        otherStandups: count,
        source: z.enum(['manual', 'group']),
        reportingManager: z.string().nullable().describe('Who else approves this person’s days off on this standup; null when nobody beyond its managers.'),
        reportingManagerName: z.string().nullable(),
      }),
    ),
    admins: z.array(Person),
    keptOff: z.array(Person).describe('Roster-group members taken off by hand; syncs keep them off.'),
    roster: z
      .strictObject({
        group: z.string().nullable(),
        syncedAt: timestamp.nullable(),
        error: z.string().nullable(),
        leftSpace: z.array(z.strictObject({ userName: z.string(), displayName: z.string(), at: timestamp })).describe('On a roster picked from the space: people taken off for leaving it, until they rejoin or a manager acts.'),
      })
      .describe('`group` is the Google Group the roster follows, or null when people are picked from the space. `syncedAt` and `error` cover either kind of sync.'),
  }),
);

export const RunNowResult = named('RunNowResult', z.enum(['started', 'already_open', 'already_closed', 'past_deadline', 'no_participants']));

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
    away: z.array(z.strictObject({ userName: z.string(), displayName: z.string(), reason: AwayReason, reasonLabel: z.string(), note: z.string().nullable() })),
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

export const MoodComment = named(
  'MoodComment',
  z.strictObject({ person: Person.nullable(), mood: Mood, comment: z.string() }),
  '`person` is null when the standup keeps moods anonymous.',
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
    moodComments: z.array(MoodComment).optional(),
  }),
  '`moodComments` is present only for callers holding `moods.comments` on the standup. On anonymous standups it has no names and is sorted by mood, then text.',
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

export const RosterSynced = named(
  'RosterSynced',
  z.strictObject({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    skipped: z.array(z.strictObject({ email: z.string(), reason: z.string() })),
    syncedAt: timestamp,
  }),
  'Names added and removed by this sync, and group members who can’t be on a standup, with why. For a roster picked from the space, added means put back after rejoining and removed means taken off for leaving.',
);

export const AddedParticipant = named(
  'AddedParticipant',
  z.strictObject({ userName: z.string(), displayName: z.string(), mandatory: z.boolean(), reachable: z.boolean() }),
  '`reachable` is false when the bot cannot DM the person yet.',
);
export const UpdatedParticipant = named(
  'UpdatedParticipant',
  z.strictObject({
    userName: z.string(),
    displayName: z.string(),
    mandatory: z.boolean(),
    onVacation: z.boolean(),
    admin: z.boolean(),
    reportingManager: z.string().nullable(),
    reportingManagerName: z.string().nullable(),
  }),
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
export const WebhookSecret = named('WebhookSecret', z.strictObject({ secret: z.string() }), 'HMAC-SHA256 key for the X-AsyncUp-Signature header. It changes only when SECRET_KEY does.');
export const SpaceMembers = named('SpaceMembers', z.strictObject({ members: z.array(Person) }));
export const ManagerCandidates = named('ManagerCandidates', z.strictObject({ managers: z.array(Person) }), 'Everyone who manages an active standup: who a reporting manager is picked from.');

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
        moodComment: z.string().nullable(),
        answers: z.array(Answer),
      }),
    ),
  }),
  'Your own answers, including your own mood comment.',
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
    workingDays: z.string().nullable().describe('Deprecated: days differ per standup, so read `standups`.'),
    workingDaysLabel: z.string().describe('Deprecated, with `workingDays`.'),
    standups: z.array(
      z.strictObject({
        standupId: id,
        name: z.string(),
        days: z.array(Weekday).describe('The standup’s own days: the default.'),
        workingDays: z.string().nullable(),
        workingDaysLabel: z.string(),
        timeOffPolicy: TimeOffPolicy,
      }),
    ),
    policies: z.array(z.strictObject({ standupId: id, name: z.string(), timeOffPolicy: TimeOffPolicy })),
    overrides: z.array(Override),
  }),
  'A person’s days on each standup: `workingDays` is null when they follow the standup’s days, `adhoc`, or a comma list of weekdays. Someone else’s schedule lists only the standups the caller manages.',
);

export const ScheduleChange = named(
  'ScheduleChange',
  z.strictObject({ ok: z.literal(true), status: z.enum(['active', 'pending']), message: z.string() }),
  '`pending` means the change became a request for a manager to approve.',
);
export const TimeOffRequests = named('TimeOffRequests', z.strictObject({ requests: z.array(Override) }));
export const Decision = named('Decision', z.strictObject({ ok: z.literal(true), message: z.string() }));

export const EditRequest = named(
  'EditRequest',
  z.strictObject({
    id,
    standupId: id,
    standupName: z.string(),
    date: z.string(),
    userName: z.string(),
    displayName: z.string(),
    reason: z.string().nullable(),
    askedAt: z.string(),
    answeredAt: z.string(),
    until: z.string(),
  }),
  'Someone asking to change their answers after the deadline. `until` is when an approved edit, or the request, ends: midnight in the standup’s timezone.',
);
export const EditRequests = named('EditRequests', z.strictObject({ requests: z.array(EditRequest) }));

// --- polls with questions

const QuestionType = named('PollQuestionType', z.enum(QUESTION_TYPES), 'short and long are text; dropdown and single take one option; multiple takes any number.');
const ResultsFor = named('PollResultsFor', z.enum(RESULTS_VISIBILITY), 'Who sees the results: everyone asked, after it closes, or the standup’s managers only.');
export const PollQuestion = named('PollQuestion', z.strictObject({ text: z.string(), type: QuestionType, required: z.boolean(), options: z.array(z.string()) }));
export const PollDraft = named(
  'PollDraft',
  z.strictObject({
    title: z.string(),
    intro: z.string().nullable().optional(),
    questions: z.array(z.strictObject({ text: z.string(), type: QuestionType, required: z.boolean().optional(), options: z.array(z.string()).optional() })),
    closesAt: z.string().describe('Local date and time in the standup’s timezone, YYYY-MM-DDTHH:mm, from 15 minutes to 14 days ahead.'),
    remindMinutes: z.union([z.literal(15), z.literal(60), z.literal(1440)]).nullable().optional(),
    anonymous: z.boolean().optional(),
    results: ResultsFor.optional(),
  }),
  'Up to 10 questions; choice questions have 2 to 20 options. Named or anonymous and who sees results cannot change once sent.',
);
const PollSummaryShape = {
  id,
  standupId: id,
  title: z.string(),
  from: z.string(),
  createdAt: timestamp,
  closesAt: timestamp,
  closesLabel: z.string(),
  closedAt: timestamp.nullable(),
  closedLabel: z.string().nullable(),
  open: z.boolean(),
  anonymous: z.boolean(),
  results: ResultsFor,
  asked: count,
  answered: count,
};
export const QuestionPollSummary = named('QuestionPollSummary', z.strictObject(PollSummaryShape));
export const QuestionPolls = named('QuestionPolls', z.strictObject({ polls: z.array(QuestionPollSummary) }));
export const QuestionPoll = named(
  'QuestionPoll',
  z.strictObject({
    ...PollSummaryShape,
    intro: z.string().nullable(),
    questions: z.array(PollQuestion),
    remindAt: timestamp.nullable(),
    outcome: z
      .strictObject({
        notAnswered: z.array(z.string()).nullable(),
        questions: z.array(
          z.strictObject({
            text: z.string(),
            type: QuestionType,
            answered: count,
            options: z.array(z.strictObject({ text: z.string(), count, names: z.array(z.string()).nullable() })),
            answers: z.array(z.strictObject({ name: z.string().nullable(), text: z.string() })),
          }),
        ),
      })
      .nullable()
      .describe('Null unless the caller may see results. Names are null on an anonymous poll.'),
  }),
);

// --- settings, verification and MCP

const secret = z.strictObject({ set: z.boolean() });

export const Settings = named(
  'Settings',
  z.strictObject({
    chat: z.strictObject({
      audience: z.string(),
      serviceAccount: z.strictObject({ set: z.boolean(), email: z.string().nullable(), clientId: z.string().nullable() }),
    }),
    workspace: z.strictObject({
      defaultTimezone: z.string(),
      calendarOoo: z.boolean(),
      workspaceAdminEmail: z.string(),
      leaveInChat: z.boolean().describe('Days off and vacation mode shown as people’s Chat status and a Calendar out-of-office event.'),
      leaveDeclineMode: z.enum(['none', 'new', 'all']).describe('What the out-of-office event does with clashing invites.'),
      leaveSyncError: z.strictObject({ message: z.string(), at: timestamp }).nullable().describe('The latest failure writing someone’s leave to Chat or Calendar.'),
      spelling: z
        .strictObject({ enabled: z.boolean(), dialect: z.enum(['en-GB', 'en-US']), words: z.array(z.string()) })
        .describe('Likely typos in Chat answers pointed out once before posting; `words` are never flagged.'),
    }),
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
  rosterGroup: z.string().nullable().describe('Google Group email the roster follows; empty or null means people are added by hand'),
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
export const UpdateParticipant = named(
  'UpdateParticipant',
  z
    .strictObject({
      mandatory: z.boolean(),
      onVacation: z.boolean(),
      admin: z.boolean(),
      reportingManager: z.string().startsWith('users/').nullable().describe('Must already manage a standup, and not be this person. null clears it.'),
    })
    .partial(),
);
export const BlockerUpdateBody = named('BlockerUpdateBody', z.strictObject({ text: text.min(1) }));
export const SkipBody = named('SkipBody', z.strictObject({ standupId: id, reason: z.string().min(1).max(LIMITS.skipNoteMax) }), 'The reason is one line, posted in the day’s thread.');
export const MyPatch = named('MyPatch', z.strictObject({ timezone: z.string().nullable(), onVacation: z.boolean() }).partial(), 'A null or empty timezone follows the standups’ zones again.');
export const WorkingDaysBody = named(
  'WorkingDaysBody',
  z.strictObject({ workingDays: z.string().optional(), standupId: id.optional() }),
  '"mon-thu", "mon,wed,fri", "adhoc", or "reset" (the default) to follow the standup, on the standup `standupId`. Without `standupId` every standup changes; that form is deprecated.',
);
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
      leaveInChat: z.boolean(),
      leaveDeclineMode: z.enum(['none', 'new', 'all']),
      spellingEnabled: z.boolean(),
      spellingDialect: z.enum(['en-GB', 'en-US']),
      spellingWords: z.string().describe('One word or phrase per line.'),
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
export const DeleteStandupBody = named('DeleteStandupBody', z.strictObject({ confirm: z.string() }), 'The standup’s exact name.');
export const VerifyWebhookBody = named('VerifyWebhookBody', z.strictObject({ standupId: id }));
export const CreateMcpTokenBody = named(
  'CreateMcpTokenBody',
  z.strictObject({ name: text.min(1), kind: z.enum(['personal', 'service']).optional(), scopes: z.array(McpScope).optional() }),
  'Service tokens are admin-only and always read-only; scopes default to the workspace default.',
);

export const PermissionList = named(
  'PermissionList',
  z.strictObject({ permissions: z.array(z.strictObject({ id: Permission, label: z.string(), description: z.string(), workspaceOnly: z.boolean() })) }),
  'Every permission a role can hold. Workspace-only ones can only be granted across the workspace.',
);
export const Role = named(
  'Role',
  z.strictObject({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    permissions: z.array(Permission),
    builtIn: z.boolean(),
    grantable: z.boolean(),
    workspaceOnly: z.boolean(),
    grants: count,
  }),
  'Built-in roles have word ids (admin, manager, viewer, member) and cannot be changed; custom roles have numeric ids.',
);
export const RoleList = named('RoleList', z.strictObject({ roles: z.array(Role) }));
export const RoleBody = named(
  'RoleBody',
  z.strictObject({ name: z.string().min(1).max(40), description: text.optional(), permissions: z.array(Permission).min(1) }),
  'You can only give a role permissions you hold yourself. `standups.view` is added whenever another standup permission is chosen, since the others need it.',
);
export const Grant = named(
  'Grant',
  z.strictObject({
    id,
    email: z.string(),
    displayName: z.string(),
    role: z.strictObject({ id: z.string(), name: z.string() }),
    standup: z.strictObject({ id, name: z.string() }).nullable(),
    grantedBy: z.string(),
    grantedAt: timestamp,
  }),
  '`standup` is null for a grant across the workspace.',
);
export const GrantList = named('GrantList', z.strictObject({ grants: z.array(Grant) }));
export const GrantBody = named(
  'GrantBody',
  z.strictObject({ email: z.string(), displayName: text.optional(), role: z.string(), standupId: id.nullable().optional() }),
  'Omit standupId for the whole workspace. On one standup, managing its people is enough to grant a role whose permissions you hold there.',
);
export const RoleAudit = named(
  'RoleAudit',
  z.strictObject({ entries: z.array(z.strictObject({ id, at: timestamp, actor: z.string(), action: z.string(), summary: z.string() })) }),
  'Newest first.',
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
export type MySubmissions = z.infer<typeof MySubmissions>;
export type Override = z.infer<typeof Override>;
export type Schedule = z.infer<typeof Schedule>;
export type EditRequest = z.infer<typeof EditRequest>;
export type Settings = z.infer<typeof Settings>;
export type Verification = z.infer<typeof Verification>;
export type McpToken = z.infer<typeof McpToken>;
export type CreatedMcpToken = z.infer<typeof CreatedMcpToken>;
export type McpActivityEntry = z.infer<typeof McpActivity>['activity'][number];
export type Me = z.infer<typeof Me>;
export type AuthMethods = z.infer<typeof AuthMethods>;
export type PermissionInfo = z.infer<typeof PermissionList>['permissions'][number];
export type Role = z.infer<typeof Role>;
export type Grant = z.infer<typeof Grant>;
export type RoleAuditEntry = z.infer<typeof RoleAudit>['entries'][number];
export type PollQuestion = z.infer<typeof PollQuestion>;
export type PollDraft = z.infer<typeof PollDraft>;
export type QuestionPollSummary = z.infer<typeof QuestionPollSummary>;
export type QuestionPoll = z.infer<typeof QuestionPoll>;
