import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type BlockerView, type RunDetail, type RunListItem, type Space, type StandupDetail, type StandupSummary, type TodayRun, type WeekPoint } from './api';

export const TODAY_POLL_MS = 15_000;

export function useStandups() {
  return useQuery({ queryKey: ['standups'], queryFn: () => api<{ standups: StandupSummary[] }>('/standups'), select: (d) => d.standups });
}

export function useStandup(id: number) {
  return useQuery({ queryKey: ['standup', id], queryFn: () => api<StandupDetail>(`/standups/${id}`) });
}

/** Today's run, polled while it is open. `dataUpdatedAt` drives the "updated 12s ago" label. */
export function useToday(id: number) {
  return useQuery({
    queryKey: ['today', id],
    queryFn: () => api<TodayRun>(`/standups/${id}/runs/today`),
    refetchInterval: (q) => (q.state.data?.status === 'open' ? TODAY_POLL_MS : false),
  });
}

export function useRuns(id: number, limit = 14) {
  return useQuery({ queryKey: ['runs', id, limit], queryFn: () => api<{ runs: RunListItem[] }>(`/standups/${id}/runs?limit=${limit}`), select: (d) => d.runs });
}

export function useRun(id: number, date: string | null) {
  return useQuery({ queryKey: ['run', id, date], queryFn: () => api<RunDetail>(`/standups/${id}/runs/${date}`), enabled: !!date });
}

export function useOpenBlockers(standupId?: number) {
  const qs = standupId ? `&standupId=${standupId}` : '';
  return useQuery({ queryKey: ['blockers', 'open', standupId ?? 'all'], queryFn: () => api<{ blockers: BlockerView[] }>(`/blockers?status=open${qs}`), select: (d) => d.blockers });
}

export function useInsights(id: number, weeks: number) {
  return useQuery({ queryKey: ['insights', id, weeks], queryFn: () => api<{ weeks: WeekPoint[] }>(`/standups/${id}/insights?weeks=${weeks}`), select: (d) => d.weeks });
}

/** Space display names, admin-only in the API; everyone else sees resource names. */
export function useSpaceNames() {
  return useQuery({
    queryKey: ['spaces'],
    queryFn: async () => {
      try {
        return (await api<{ spaces: Space[] }>('/spaces')).spaces;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 502)) return [];
        throw err;
      }
    },
    staleTime: 10 * 60_000,
    select: (spaces) => new Map(spaces.map((s) => [s.name, s.displayName])),
  });
}

export function spaceLabel(names: Map<string, string> | undefined, spaceName: string): string {
  const display = names?.get(spaceName);
  return display ? `#${display}` : spaceName;
}

function useStandupAction(id: number, path: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ result: string }>(`/standups/${id}/${path}`, { method: 'POST' }),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ['today', id] }), client.invalidateQueries({ queryKey: ['standups'] }), client.invalidateQueries({ queryKey: ['runs', id] })]),
  });
}
export const useRunNow = (id: number) => useStandupAction(id, 'run-now');
export const useNudge = (id: number) => useStandupAction(id, 'nudge');

export function useBlockerAction(action: 'acknowledge' | 'resolve') {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (blockerId: number) => api<{ result: string }>(`/blockers/${blockerId}/${action}`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['blockers'] }),
  });
}

export const RUN_NOW_COPY: Record<string, string> = {
  started: 'Today’s run is open — everyone eligible was just prompted.',
  already_open: 'Today’s run is already open — anyone not yet prompted was just prompted.',
  already_closed: 'Today’s run already closed. The next one opens on schedule.',
  no_participants: 'No one to prompt — add people first (or everyone is on vacation).',
};
