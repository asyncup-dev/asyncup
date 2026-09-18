import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type TimeOffPolicy } from './api';

export interface OverrideView {
  id: number;
  userName: string;
  displayName: string;
  date: string;
  working: boolean;
  reason: string;
  status: 'active' | 'pending' | 'declined' | 'expired' | 'withdrawn';
  label: string;
  setBy: string;
  channel: string;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface ScheduleView {
  userName: string;
  displayName: string;
  workingDays: string | null;
  workingDaysLabel: string;
  policies: { standupId: number; name: string; timeOffPolicy: TimeOffPolicy }[];
  overrides: OverrideView[];
}

/** Either the caller's own schedule or someone else's, by Chat user name. */
export type ScheduleTarget = 'me' | { userName: string };

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const DAY_LABEL: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

export const POLICY_LABEL: Record<TimeOffPolicy, string> = {
  self: 'Self-service — managers get a daily digest',
  approval: 'Needs a manager’s approval',
  managers: 'Managers only',
};

export const STATUS_TONE: Record<OverrideView['status'], string> = { active: '', pending: 'badge-info', declined: 'badge-danger', expired: '', withdrawn: '' };

function base(target: ScheduleTarget): string {
  return target === 'me' ? '/me' : `/people/${encodeURIComponent(target.userName)}`;
}

export function scheduleKey(target: ScheduleTarget): (string | number)[] {
  return ['schedule', target === 'me' ? 'me' : target.userName];
}

export function useSchedule(target: ScheduleTarget, enabled = true) {
  return useQuery({ queryKey: scheduleKey(target), queryFn: () => api<ScheduleView>(`${base(target)}/schedule`), enabled });
}

function invalidate(client: ReturnType<typeof useQueryClient>, target: ScheduleTarget) {
  return Promise.all([
    client.invalidateQueries({ queryKey: scheduleKey(target) }),
    client.invalidateQueries({ queryKey: ['people'] }),
    client.invalidateQueries({ queryKey: ['me-standups'] }),
    client.invalidateQueries({ queryKey: ['today'] }),
    client.invalidateQueries({ queryKey: ['requests'] }),
  ]);
}

export function useSaveWeek(target: ScheduleTarget) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (workingDays: string) => api<ScheduleView>(`${base(target)}/schedule`, { method: 'PATCH', body: { workingDays } }),
    onSuccess: () => invalidate(client, target),
  });
}

export interface OverrideInput {
  date?: string;
  from?: string;
  to?: string;
  working: boolean;
  reason: string;
}

export function useAddOverride(target: ScheduleTarget) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: OverrideInput) => api<{ ok: true; status: 'active' | 'pending'; message: string }>(`${base(target)}/overrides`, { method: 'POST', body: input }),
    onSuccess: () => invalidate(client, target),
  });
}

export function useCancelOverride(target: ScheduleTarget) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (date: string) => api<{ ok: true; message: string }>(`${base(target)}/overrides/${date}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(client, target),
  });
}

export function useRequests(enabled: boolean) {
  return useQuery({ queryKey: ['requests'], queryFn: () => api<{ requests: OverrideView[] }>('/requests'), select: (d) => d.requests, enabled });
}

export function useDecide() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, approve, note }: { ids: number[]; approve: boolean; note?: string }) =>
      api<{ ok: true; message: string }>(`/requests/${ids.join(',')}/${approve ? 'approve' : 'decline'}`, { method: 'POST', body: note ? { note } : {} }),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ['requests'] }), client.invalidateQueries({ queryKey: ['people'] }), client.invalidateQueries({ queryKey: ['today'] })]),
  });
}

/** The stored week as a set of days, for the chip toggles ("" for ad hoc, null for follow). */
export function weekToDays(workingDays: string | null): string[] {
  return workingDays && workingDays !== 'adhoc' ? workingDays.split(',') : [];
}

/** Pending requests grouped so one person's range is one decision. */
export function groupRequests(requests: OverrideView[]): { key: string; ids: number[]; person: string; userName: string; dates: string[]; working: boolean; reason: string; createdAt: string; channel: string }[] {
  const groups = new Map<string, ReturnType<typeof groupRequests>[number]>();
  for (const r of requests) {
    const key = `${r.userName}:${r.working}:${r.reason}:${r.createdAt}`;
    const g = groups.get(key);
    if (g) {
      g.ids.push(r.id);
      g.dates.push(r.date);
    } else groups.set(key, { key, ids: [r.id], person: r.displayName, userName: r.userName, dates: [r.date], working: r.working, reason: r.reason, createdAt: r.createdAt, channel: r.channel });
  }
  return [...groups.values()];
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 19 Sep" or "Mon 22 Sep – Wed 24 Sep" from ISO dates, the same wording the bot uses. */
export function dateSpan(dates: string[]): string {
  const fmt = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return `${WEEKDAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
  };
  const sorted = [...dates].sort();
  return sorted.length === 1 ? fmt(sorted[0]!) : `${fmt(sorted[0]!)} – ${fmt(sorted[sorted.length - 1]!)}`;
}

/** Today's and tomorrow's ISO dates in the browser's zone. */
export function isoToday(offsetDays = 0, now = new Date()): string {
  const d = new Date(now.getTime() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
