import type { Repo } from '../db/repo.js';
import { TIME_OFF_POLICIES, type Standup, type TimeOffPolicy } from './types.js';
import { HTTPS_URL_RE, LIMITS, isEscalateDays, isReminderMinutes, isValidTime, isValidZone, parseDays } from './validation.js';

/**
 * The one place a standup's configuration is validated for the web
 * surfaces (the JSON API and the standup's settings). Only keys present in `input` are
 * checked; cross-field rules use the standup's current values for the
 * rest, so partial updates behave like a full save would.
 */
export interface StandupConfigInput {
  name?: unknown;
  promptTime?: unknown;
  deadlineTime?: unknown;
  timezone?: unknown;
  reminderMinutesBefore?: unknown;
  escalateAfterDays?: unknown;
  /** "mon,tue" or ["mon", "tue"] */
  days?: unknown;
  /** Empty string or null disables. */
  webhookUrl?: unknown;
  questions?: unknown;
  moodEnabled?: unknown;
  moodAnonymous?: unknown;
  digestEnabled?: unknown;
  /** self | approval | managers */
  timeOffPolicy?: unknown;
  /** Participant userName, or empty/null to switch escalation off. */
  escalateUserName?: unknown;
}

export type StandupConfigFields = Partial<
  Pick<
    Standup,
    | 'name'
    | 'promptTime'
    | 'deadlineTime'
    | 'timezone'
    | 'reminderMinutesBefore'
    | 'escalateAfterDays'
    | 'days'
    | 'webhookUrl'
    | 'questions'
    | 'moodEnabled'
    | 'moodAnonymous'
    | 'digestEnabled'
    | 'timeOffPolicy'
    | 'escalateUserName'
    | 'escalateDisplayName'
  >
>;

export type StandupConfigResult =
  | { ok: true; fields: StandupConfigFields }
  | { ok: false; field: keyof StandupConfigInput; message: string };

const fail = (field: keyof StandupConfigInput, message: string): StandupConfigResult => ({ ok: false, field, message });

function bool(field: keyof StandupConfigInput, value: unknown): boolean | StandupConfigResult {
  return typeof value === 'boolean' ? value : fail(field, 'Must be true or false.');
}

export async function validateStandupConfig(
  repo: Repo,
  standup: Standup,
  input: StandupConfigInput,
): Promise<StandupConfigResult> {
  const fields: StandupConfigFields = {};
  const has = (k: keyof StandupConfigInput) => input[k] !== undefined;

  if (has('name')) {
    const name = String(input.name).trim();
    if (!name) return fail('name', 'Name is required.');
    fields.name = name;
  }
  if (has('promptTime') || has('deadlineTime')) {
    const promptTime = has('promptTime') ? String(input.promptTime) : standup.promptTime;
    const deadlineTime = has('deadlineTime') ? String(input.deadlineTime) : standup.deadlineTime;
    if (!isValidTime(promptTime)) return fail('promptTime', 'Times must be HH:MM (24h).');
    if (!isValidTime(deadlineTime)) return fail('deadlineTime', 'Times must be HH:MM (24h).');
    if (promptTime >= deadlineTime) return fail('promptTime', 'Prompt time must be before the deadline.');
    fields.promptTime = promptTime;
    fields.deadlineTime = deadlineTime;
  }
  if (has('timezone')) {
    const timezone = String(input.timezone);
    if (!isValidZone(timezone)) return fail('timezone', `Invalid IANA timezone: ${timezone}`);
    fields.timezone = timezone;
  }
  if (has('reminderMinutesBefore')) {
    const reminder = Number(input.reminderMinutesBefore);
    if (!isReminderMinutes(reminder)) return fail('reminderMinutesBefore', `Reminder must be 0–${LIMITS.reminderMinutesMax} minutes.`);
    fields.reminderMinutesBefore = reminder;
  }
  if (has('escalateAfterDays')) {
    const days = Number(input.escalateAfterDays);
    if (!isEscalateDays(days)) {
      return fail('escalateAfterDays', `Escalation days must be ${LIMITS.escalateDaysMin}–${LIMITS.escalateDaysMax}.`);
    }
    fields.escalateAfterDays = days;
  }
  if (has('timeOffPolicy')) {
    const policy = String(input.timeOffPolicy);
    if (!(TIME_OFF_POLICIES as readonly string[]).includes(policy)) return fail('timeOffPolicy', 'Time-off policy must be self, approval or managers.');
    fields.timeOffPolicy = policy as TimeOffPolicy;
  }
  if (has('days')) {
    const raw = Array.isArray(input.days) ? input.days.join(',') : String(input.days);
    const days = parseDays(raw);
    if (!days) return fail('days', 'Days must be a comma list of mon,tue,wed,thu,fri,sat,sun.');
    fields.days = days.join(',');
  }
  if (has('webhookUrl')) {
    const url = input.webhookUrl === null ? '' : String(input.webhookUrl).trim();
    if (url && !HTTPS_URL_RE.test(url)) return fail('webhookUrl', 'Webhook URL must be https:// (or empty to disable).');
    fields.webhookUrl = url || null;
  }
  if (has('questions')) {
    const list = Array.isArray(input.questions) ? input.questions : [];
    const questions = list.map((q) => String(q).trim()).filter(Boolean);
    if (questions.length === 0 || questions.length > LIMITS.questionsMax) {
      return fail('questions', `Provide 1–${LIMITS.questionsMax} questions (one per line).`);
    }
    if (questions.some((q) => q.length > LIMITS.textMax)) return fail('questions', `Questions must be ≤${LIMITS.textMax} characters.`);
    fields.questions = questions;
  }
  for (const key of ['moodEnabled', 'moodAnonymous', 'digestEnabled'] as const) {
    if (!has(key)) continue;
    const value = bool(key, input[key]);
    if (typeof value !== 'boolean') return value;
    fields[key] = value;
  }
  if (has('escalateUserName')) {
    const userName = input.escalateUserName === null ? '' : String(input.escalateUserName);
    if (userName === '') {
      fields.escalateUserName = null;
      fields.escalateDisplayName = null;
    } else {
      // Picked from the roster — those people have Chat identities.
      const contact = (await repo.listParticipants(standup.id)).find((p) => p.userName === userName);
      if (!contact) return fail('escalateUserName', 'Escalation contact must be a current participant.');
      fields.escalateUserName = contact.userName;
      fields.escalateDisplayName = contact.displayName;
    }
  }
  return { ok: true, fields };
}
