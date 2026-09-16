import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Settings, type Verification } from './api';

export interface McpTokenView {
  id: number;
  name: string;
  kind: 'personal' | 'service';
  owner: { userName: string; displayName: string | null } | null;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export interface McpActivityRow {
  id: number;
  token: { id: number; name: string };
  tool: string;
  argsSummary: string;
  ok: boolean;
  at: string;
}

export type SettingsView = Settings & {
  tokens: { tick: { set: boolean }; export: { set: boolean }; scim: { set: boolean } };
  mcp: { enabled: boolean; defaultScopes: string[]; endpoint: string; scopes: Record<string, string> };
};

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsView>('/settings') });
}

/** PATCH /settings; the API's `{ error: { message, field } }` becomes the thrown ApiError. */
export function usePatchSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<SettingsView>('/settings', { method: 'PATCH', body: patch }),
    onSuccess: (data) => {
      client.setQueryData(['settings'], data);
      void client.invalidateQueries({ queryKey: ['setup-progress'] });
      void client.invalidateQueries({ queryKey: ['auth-methods'] });
    },
  });
}

export function useVerifyMutation(name: string) {
  return useMutation({ mutationFn: (body?: Record<string, unknown>) => api<Verification>(`/verify/${name}`, { method: 'POST', ...(body ? { body } : {}) }) });
}

export function useMachineToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, action }: { name: 'tick' | 'export' | 'scim'; action: 'generate' | 'clear' }) =>
      action === 'generate' ? api<{ name: string; token: string }>(`/settings/tokens/${name}`, { method: 'POST' }) : api<undefined>(`/settings/tokens/${name}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['settings'] }),
  });
}

export function useMcpTokens() {
  return useQuery({ queryKey: ['mcp-tokens'], queryFn: () => api<{ tokens: McpTokenView[] }>('/mcp/tokens'), select: (d) => d.tokens });
}

export function useMcpActivity(limit = 8) {
  return useQuery({ queryKey: ['mcp-activity', limit], queryFn: () => api<{ activity: McpActivityRow[] }>(`/mcp/activity?limit=${limit}`), select: (d) => d.activity });
}

export function useCreateMcpToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; kind: 'personal' | 'service'; scopes: string[] }) => api<McpTokenView & { secret: string; config: { url: string; headers: Record<string, string> } }>('/mcp/tokens', { method: 'POST', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['mcp-tokens'] }),
  });
}

export function useRevokeMcpToken() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (id: number) => api<undefined>(`/mcp/tokens/${id}`, { method: 'DELETE' }), onSuccess: () => client.invalidateQueries({ queryKey: ['mcp-tokens'] }) });
}

/** Ready-to-paste MCP client configs. */
export function clientSnippet(kind: 'claude-desktop' | 'claude-code' | 'cursor' | 'generic', url: string, token = '<your token>'): string {
  if (kind === 'claude-code') return `claude mcp add --transport http asyncup ${url} --header "Authorization: Bearer ${token}"`;
  if (kind === 'generic') return `POST ${url}\nAuthorization: Bearer ${token}\nContent-Type: application/json\nAccept: application/json, text/event-stream`;
  return JSON.stringify({ mcpServers: { asyncup: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}
