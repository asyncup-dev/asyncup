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

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

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
  active: boolean;
}

export interface Participant {
  standupId: number;
  /** Platform user id, e.g. "users/1234567890" */
  userName: string;
  displayName: string;
  /** IANA zone overriding the standup timezone for prompt delivery */
  timezone: string | null;
  mandatory: boolean;
  active: boolean;
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
  promptedAt: string | null;
  remindedAt: string | null;
}

export interface SubmissionAnswers {
  yesterday: string;
  today: string;
  blockers: string;
  mood: Mood;
}

export interface Submission extends SubmissionAnswers {
  id: number;
  runId: number;
  userName: string;
  displayName: string;
  late: boolean;
  submittedAt: string;
}

export interface RunSummary {
  standupName: string;
  date: string;
  mandatoryTotal: number;
  mandatorySubmitted: number;
  missingMandatory: string[];
  optionalSubmitted: number;
  lateCount: number;
}

export function standupDays(standup: Standup): Weekday[] {
  return standup.days.split(',').map((d) => d.trim() as Weekday);
}

export function hasBlockers(blockers: string): boolean {
  const normalized = blockers.trim().toLowerCase();
  return normalized !== '' && !['none', 'no', 'nope', 'nothing', 'na', 'n/a', '-'].includes(normalized);
}
