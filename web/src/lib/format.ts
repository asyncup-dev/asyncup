const DAY_LABEL: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** "Mon–Fri" for a contiguous run, otherwise "Mon, Wed, Fri". */
export function daysLabel(days: string[]): string {
  const idx = days.map((d) => ORDER.indexOf(d)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (idx.length === 0) return '—';
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1]! + 1);
  if (contiguous && idx.length > 2) return `${DAY_LABEL[ORDER[idx[0]!]!]}–${DAY_LABEL[ORDER[idx[idx.length - 1]!]!]}`;
  return idx.map((i) => DAY_LABEL[ORDER[i]!]).join(', ');
}

/** "IST" style short zone name when the platform knows one, else the IANA id. */
export function zoneAbbr(zone: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
    return part?.value ?? zone;
  } catch {
    return zone;
  }
}

/** "Wed 16 Sep" from an ISO date (no time, no zone shift). */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** "Tuesday 15 September". */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** "September" for grouping a run list. */
export function monthOf(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, 1)));
}

/** "09:41" in the standup's zone. */
export function clock(isoInstant: string, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone }).format(new Date(isoInstant));
  } catch {
    return isoInstant.slice(11, 16);
  }
}

/** Minutes past midnight right now in a zone. */
export function minutesNowIn(zone: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: zone }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return h * 60 + m;
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/** "Closes in 1h 12m" / "Closes in 8m" / "Past deadline". */
export function closesIn(deadline: string, zone: string, now = new Date()): string {
  const [h, m] = deadline.split(':').map(Number);
  const left = h! * 60 + m! - minutesNowIn(zone, now);
  if (left <= 0) return 'Past deadline';
  const hh = Math.floor(left / 60);
  return `Closes in ${hh ? `${hh}h ` : ''}${left % 60}m`;
}

/** "12s ago" / "3m ago". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export function pct(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 100) : 0;
}

export function names(people: { displayName: string }[], max = 4): string {
  const list = people.map((p) => p.displayName.split(' ')[0]!);
  return list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} +${list.length - max}`;
}
