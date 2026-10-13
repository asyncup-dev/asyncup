export const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEK)[number];
export const DAY_LABEL: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/** A stored personal week as a list: null follows the standup, "adhoc" has no fixed days. */
function storedDays(workingDays: string | null): Weekday[] | null {
  if (workingDays === null) return null;
  if (workingDays === 'adhoc') return [];
  return WEEK.filter((d) => workingDays.split(',').includes(d));
}

/** Which of the standup's days the person works, as the grid ticks them. */
export function tickedDays(workingDays: string | null, standupDays: readonly Weekday[]): Weekday[] {
  const own = storedDays(workingDays);
  return own === null ? [...standupDays] : standupDays.filter((d) => own.includes(d));
}

/**
 * The week to save after ticking `picked` among the standup's days, in the
 * form the schedule API takes. Days outside this standup are kept, since a
 * week belongs to the person; ticking every standup day with nothing else
 * set goes back to following the standup.
 */
export function weekAfter(workingDays: string | null, standupDays: readonly Weekday[], picked: readonly Weekday[]): string {
  const outside = (storedDays(workingDays) ?? []).filter((d) => !standupDays.includes(d));
  if (outside.length === 0 && standupDays.every((d) => picked.includes(d))) return 'reset';
  const all = WEEK.filter((d) => outside.includes(d) || (standupDays.includes(d) && picked.includes(d)));
  return all.length ? all.join(',') : 'adhoc';
}
