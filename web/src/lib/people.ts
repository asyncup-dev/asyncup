import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type BlockerView, type Person, type StandupDetail } from './api';

import type { TeamMember as PersonRow } from '../../../src/api/spec/schemas.ts';

export type { PersonRow };

export function usePeople() {
  return useQuery({ queryKey: ['people'], queryFn: () => api<{ people: PersonRow[] }>('/people'), select: (d) => d.people });
}

export function roleOf(p: PersonRow): 'Manager' | 'Member' {
  return p.standups.some((s) => s.admin) ? 'Manager' : 'Member';
}

function invalidateRoster(client: ReturnType<typeof useQueryClient>, standupId: number) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ['people'] }),
    client.invalidateQueries({ queryKey: ['standup', standupId] }),
    client.invalidateQueries({ queryKey: ['standups'] }),
    client.invalidateQueries({ queryKey: ['today', standupId] }),
  ]);
}

export function useParticipantPatch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ standupId, userName, patch }: { standupId: number; userName: string; patch: { mandatory?: boolean; onVacation?: boolean; admin?: boolean; reportingManager?: string | null } }) =>
      api<unknown>(`/standups/${standupId}/participants/${encodeURIComponent(userName)}`, { method: 'PATCH', body: patch }),
    onSuccess: (_d, v) => invalidateRoster(client, v.standupId),
  });
}

export function useParticipantRemove() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ standupId, userName }: { standupId: number; userName: string }) => api<undefined>(`/standups/${standupId}/participants/${encodeURIComponent(userName)}`, { method: 'DELETE' }),
    onSuccess: (_d, v) => invalidateRoster(client, v.standupId),
  });
}

export function useParticipantAdd() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ standupId, person, mandatory }: { standupId: number; person: Person; mandatory: boolean }) =>
      api<{ reachable: boolean }>(`/standups/${standupId}/participants`, { method: 'POST', body: { ...person, mandatory } }),
    onSuccess: (_d, v) => invalidateRoster(client, v.standupId),
  });
}

export interface RosterSynced {
  added: string[];
  removed: string[];
  skipped: { email: string; reason: string }[];
  syncedAt: string;
}

/** Pull the roster group's members now instead of waiting for the hourly sync. */
export function useRosterSync(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<RosterSynced>(`/standups/${id}/roster/sync`, { method: 'POST' }),
    onSettled: () => invalidateRoster(client, id),
  });
}

/** Members of the standup's Chat space — the rows of its people grid. */
export function useStandupMembers(id: number, enabled = true) {
  return useQuery({ queryKey: ['standup-members', id], queryFn: () => api<{ members: Person[] }>(`/standups/${id}/members`), select: (d) => d.members, enabled });
}

/** Everyone who manages an active standup: who a reporting manager is picked from. */
export function useManagerCandidates(id: number, enabled = true) {
  return useQuery({ queryKey: ['manager-candidates', id], queryFn: () => api<{ managers: Person[] }>(`/standups/${id}/manager-candidates`), select: (d) => d.managers, enabled });
}

export function useStandupPatch(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<StandupDetail>(`/standups/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ['standup', id] }), client.invalidateQueries({ queryKey: ['standups'] })]),
  });
}

/** Deletes an archived standup and all its history; workspace admins only. */
export function useDeleteStandup(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<{ deleted: { runs: number; submissions: number; blockers: number; polls: number } }>(`/standups/${id}`, { method: 'DELETE', body: { confirm: name } }),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ['standups'] }), client.invalidateQueries({ queryKey: ['setup-progress'] })]),
  });
}

export function useArchive(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: 'archive' | 'unarchive') => api<unknown>(`/standups/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ['standup', id] }), client.invalidateQueries({ queryKey: ['standups'] })]),
  });
}

export function useBlockers(params: { status: string; standupId?: number | null; owner?: string }) {
  const qs = new URLSearchParams({ status: params.status });
  if (params.standupId) qs.set('standupId', String(params.standupId));
  if (params.owner) qs.set('owner', params.owner);
  return useQuery({ queryKey: ['blockers', params.status, params.standupId ?? 'all', params.owner ?? ''], queryFn: () => api<{ blockers: BlockerView[] }>(`/blockers?${qs}`), select: (d) => d.blockers });
}

export function useBlockerUpdate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, text }: { id: number; text: string }) => api<{ result: string }>(`/blockers/${id}/update`, { method: 'POST', body: { text } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['blockers'] }),
  });
}

/** "3 days" / "5 hours" since an ISO date (YYYY-MM-DD) or instant. */
export function ageOf(from: string, now = new Date()): string {
  const start = from.length === 10 ? new Date(`${from}T00:00:00Z`) : new Date(from);
  const hours = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 3_600_000));
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
