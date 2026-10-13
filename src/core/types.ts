export const MOODS = ['great', 'good', 'okay', 'meh', 'struggling'] as const;
export type Mood = (typeof MOODS)[number];

export const MOOD_EMOJI: Record<Mood, string> = {
  great: '😄',
  good: '🙂',
  okay: '😐',
  meh: '😕',
  struggling: '😫',
};

export const MOOD_LABEL: Record<Mood, string> = {
  great: '😄 Great',
  good: '🙂 Good',
  okay: '😐 Okay',
  meh: '😕 Meh',
  struggling: '😫 Struggling',
};

export const MOOD_SCORE: Record<Mood, number> = {
  great: 5,
  good: 4,
  okay: 3,
  meh: 2,
  struggling: 1,
};

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const DEFAULT_QUESTIONS = [
  'What did you do yesterday?',
  'What will you do today?',
  'Any blockers?',
] as const;

export interface Standup {
  id: number;
  tenantId: string;
  /** Google Chat space where reports are posted, e.g. "spaces/AAAA" */
  spaceName: string;
  name: string;
  /** "HH:MM" 24h, in `timezone` (or participant timezone override) */
  promptTime: string;
  /** "HH:MM" 24h, in `timezone` */
  deadlineTime: string;
  reminderMinutesBefore: number;
  timezone: string;
  /** comma-separated subset of WEEKDAYS, e.g. "mon,tue,wed,thu,fri" */
  days: string;
  /** null = DEFAULT_QUESTIONS */
  questions: string[] | null;
  moodEnabled: boolean;
  /** Hide per-person mood on cards; the wrap-up shows the team aggregate instead. */
  moodAnonymous: boolean;
  digestEnabled: boolean;
  /** Who may mark people away and whether a manager must approve — see TIME_OFF_POLICIES. */
  timeOffPolicy: TimeOffPolicy;
  /** Who gets DMed about stale blockers; null = escalation off. */
  escalateUserName: string | null;
  escalateDisplayName: string | null;
  escalateAfterDays: number;
  /** JSON POSTs on submissions and wrap-ups; null = off. */
  webhookUrl: string | null;
  active: boolean;
}

export interface Poll {
  id: number;
  standupId: number;
  question: string;
  options: string[];
  createdBy: string;
  createdDisplay: string;
  messageName: string | null;
  closedAt: string | null;
}

export interface ScimUser {
  /** SCIM resource id (uuid, ours). */
  id: string;
  externalId: string | null;
  /** IdP userName — unique, usually the email. */
  userName: string;
  displayName: string | null;
  email: string | null;
  /** Chat resource name "users/<id>" once resolved via the Directory. */
  chatUserName: string | null;
  active: boolean;
}

export interface PollVote {
  pollId: number;
  userName: string;
  displayName: string;
  optionIndex: number;
}

export function standupQuestions(standup: Standup): string[] {
  return standup.questions ?? [...DEFAULT_QUESTIONS];
}

export interface Participant {
  standupId: number;
  /** Platform user id, e.g. "users/1234567890" */
  userName: string;
  displayName: string;
  /** IANA zone overriding the standup timezone for prompt delivery */
  timezone: string | null;
  mandatory: boolean;
  onVacation: boolean;
  /**
   * Personal week: null follows the standup's days, "adhoc" means no fixed
   * days (only dates marked working count), otherwise a comma-separated
   * subset of WEEKDAYS.
   */
  workingDays: string | null;
  active: boolean;
}

export const TIME_OFF_POLICIES = ['self', 'approval', 'managers'] as const;
/** self: people mark themselves away, managers get a digest · approval: a manager must approve · managers: only managers can. */
export type TimeOffPolicy = (typeof TIME_OFF_POLICIES)[number];

export const AWAY_REASONS = ['vacation', 'calendar_ooo', 'day_off', 'off_day', 'skipped'] as const;
/** Why someone is not expected on a run: day_off is a dated override, off_day a weekday outside their week. */
export type AwayReason = (typeof AWAY_REASONS)[number];

export const OVERRIDE_STATUSES = ['active', 'pending', 'declined', 'expired', 'withdrawn'] as const;
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number];
export type ScheduleChannel = 'chat' | 'console' | 'api';

/** One date on which a person is off or working regardless of their week. */
export interface ScheduleOverride {
  id: number;
  userName: string;
  displayName: string;
  /** ISO date in the standups' timezone. */
  date: string;
  working: boolean;
  reason: string;
  status: OverrideStatus;
  setByUserName: string;
  setByDisplayName: string;
  channel: ScheduleChannel;
  decidedByDisplayName: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A self-service schedule change waiting to be digested to managers. */
export interface ScheduleChange {
  id: number;
  userName: string;
  displayName: string;
  summary: string;
  byDisplayName: string;
  channel: ScheduleChannel;
  at: string;
}

export interface Admin {
  standupId: number;
  userName: string;
  displayName: string;
}

export type RunStatus = 'open' | 'closed';

export interface Run {
  id: number;
  standupId: number;
  /** ISO date "YYYY-MM-DD" in the standup's timezone */
  date: string;
  threadKey: string;
  status: RunStatus;
}

/** Roster snapshot taken when the run is created. */
export interface RunParticipant {
  runId: number;
  userName: string;
  displayName: string;
  timezone: string | null;
  mandatory: boolean;
  onVacation: boolean;
  awayReason: AwayReason | null;
  promptedAt: string | null;
  remindedAt: string | null;
  skippedAt: string | null;
}

export interface Answer {
  /** Question text snapshotted at submission time. */
  question: string;
  answer: string;
}

export interface SubmissionInput {
  answers: Answer[];
  mood: Mood | null;
}

export interface Submission extends SubmissionInput {
  id: number;
  runId: number;
  userName: string;
  displayName: string;
  late: boolean;
  submittedAt: string;
  editedAt: string | null;
  /** Chat message resource name of the posted card (for edits). */
  messageName: string | null;
}

export interface Blocker {
  id: number;
  standupId: number;
  userName: string;
  displayName: string;
  text: string;
  openedRunId: number;
  openedDate: string;
  resolvedRunId: number | null;
  resolvedDate: string | null;
  /** Display name of who resolved it, or "auto" for clean-submission auto-resolve. */
  resolvedBy: string | null;
  escalatedAt: string | null;
}

export interface BlockerTag {
  blockerId: number;
  userName: string;
  displayName: string;
  taggedBy: string;
  taggedAt: string;
  acknowledgedAt: string | null;
  lastNudgedAt: string | null;
}

export interface BlockerUpdate {
  id: number;
  blockerId: number;
  userName: string;
  displayName: string;
  text: string;
  createdAt: string;
}

export interface RunSummary {
  standupName: string;
  date: string;
  mandatoryTotal: number;
  mandatorySubmitted: number;
  missingMandatory: string[];
  /** Mandatory people excluded from the count: skipped or on vacation. */
  away: string[];
  optionalSubmitted: number;
  lateCount: number;
  openBlockers: number;
  /** Average mood (1-5) of today's submissions — only set when mood is anonymous. */
  teamMood: number | null;
}

export interface WeeklyDigest {
  standupName: string;
  weekStart: string;
  weekEnd: string;
  runCount: number;
  participationPct: number;
  prevParticipationPct: number | null;
  avgMood: number | null;
  prevAvgMood: number | null;
  blockersOpened: number;
  blockersResolved: number;
  openBlockers: { displayName: string; text: string; ageDays: number }[];
}

export function standupDays(standup: Standup): Weekday[] {
  return standup.days.split(',').map((d) => d.trim() as Weekday);
}

const NO_BLOCKER_WORDS = ['', 'none', 'no', 'nope', 'nothing', 'na', 'n/a', '-', 'nil'];

export function isBlockerQuestion(question: string): boolean {
  return /blocker|blocked|stuck/i.test(question);
}

export function isYesterdayQuestion(question: string): boolean {
  return /yesterday|last working day/i.test(question);
}

export function isTodayQuestion(question: string): boolean {
  return /today/i.test(question) && !isYesterdayQuestion(question);
}

export function isRealBlocker(answer: string): boolean {
  return !NO_BLOCKER_WORDS.includes(answer.trim().toLowerCase());
}

/** Non-trivial blocker answers from a submission. */
export function blockerAnswers(submission: SubmissionInput): string[] {
  return submission.answers
    .filter((a) => isBlockerQuestion(a.question) && isRealBlocker(a.answer))
    .map((a) => a.answer);
}

export interface McpToken {
  id: number;
  tenantId: string;
  name: string;
  kind: 'personal' | 'service';
  /** null for service tokens — they act as the tenant, read-only. */
  ownerUserName: string | null;
  ownerDisplayName: string | null;
  /** Whether the owner was a Workspace admin when the token was minted. */
  ownerAdmin: boolean;
  /** Comma list of MCP scopes. */
  scopes: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Rolling: pushed forward on every use. */
  expiresAt: string;
  revokedAt: string | null;
}

export interface McpActivity {
  id: number;
  token: { id: number; name: string };
  tool: string;
  argsSummary: string;
  ok: boolean;
  at: string;
}
