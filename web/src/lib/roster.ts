export const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEK)[number];
export const DAY_LABEL: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/** A stored personal week as a list: null follows the standup, "adhoc" has no fixed days. */
function storedDays(workingDays: string | null): Weekday[] | null {
  if (workingDays === null) return null;
  if (workingDays === 'adhoc') return [];
  return WEEK.filter((d) => workingDays.split(',').includes(d));
}

/** Which days the person works on this standup: their own, else the standup's. */
export function tickedDays(workingDays: string | null, standupDays: readonly Weekday[]): Weekday[] {
  return storedDays(workingDays) ?? [...standupDays];
}

/**
 * The days to save after ticking `picked`, in the form the schedule API
 * takes. Ticking exactly the standup's days puts the person back on them,
 * so later changes to the standup reach them; ticking none is ad hoc.
 */
export function weekAfter(standupDays: readonly Weekday[], picked: readonly Weekday[]): string {
  const days = WEEK.filter((d) => picked.includes(d));
  if (days.length === standupDays.length && standupDays.every((d) => days.includes(d))) return 'reset';
  return days.length ? days.join(',') : 'adhoc';
}
