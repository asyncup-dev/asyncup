import { IANAZone } from 'luxon';
import { WEEKDAYS, type Weekday } from './types.js';

/**
 * The single source for input rules enforced on more than one surface
 * (chat commands, the JSON API, SCIM). Surfaces keep their own
 * error wording; the rules themselves live here so they cannot drift.
 */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const HTTPS_URL_RE = /^https:\/\/\S+$/i;

export const LIMITS = {
  reminderMinutesMax: 24 * 60,
  escalateDaysMin: 1,
  escalateDaysMax: 30,
  questionsMax: 10,
  /** Max length for questions, poll questions and poll options. */
  textMax: 200,
  exportDaysMax: 365,
} as const;

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function isValidZone(value: string): boolean {
  return IANAZone.isValidZone(value);
}

export function isReminderMinutes(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= LIMITS.reminderMinutesMax;
}

export function isEscalateDays(n: number): boolean {
  return Number.isInteger(n) && n >= LIMITS.escalateDaysMin && n <= LIMITS.escalateDaysMax;
}

/** Parse a day list ("mon,tue …") into canonical order; null when invalid. */
export function parseDays(value: string): Weekday[] | null {
  const days = value
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean) as Weekday[];
  if (days.length === 0 || days.some((d) => !WEEKDAYS.includes(d))) return null;
  return WEEKDAYS.filter((d) => days.includes(d));
}

/** Linear-time email shape check (no backtracking regex — CodeQL ReDoS). */
export function looksLikeEmail(value: string): boolean {
  const at = value.indexOf('@');
  const dot = value.lastIndexOf('.');
  return at > 0 && at === value.lastIndexOf('@') && dot > at + 1 && dot < value.length - 1 && !/\s/.test(value);
}

/** Clamp a ?days= query value into [1, exportDaysMax]. */
export function clampExportDays(raw: unknown, fallback: number): number {
  return Math.min(Math.max(Number(raw) || fallback, 1), LIMITS.exportDaysMax);
}
