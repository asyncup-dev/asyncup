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
  aiEnabled: boolean;
  /** Who gets DMed about stale blockers; null = escalation off. */
  escalateUserName: string | null;
  escalateDisplayName: string | null;
  escalateAfterDays: number;
  active: boolean;
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
  active: boolean;
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
  escalatedAt: string | null;
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
