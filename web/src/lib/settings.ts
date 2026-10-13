import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatedMcpToken, McpActivityEntry, McpScope, McpToken } from '../../../src/api/spec/schemas.ts';
import { api, type Settings, type Verification } from './api';

export type { McpActivityEntry as McpActivityRow, McpScope, McpToken as McpTokenView } from '../../../src/api/spec/schemas.ts';

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/settings') });
}

/** PATCH /settings; the API's `{ error: { message, field } }` becomes the thrown ApiError. */
export function usePatchSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<Settings>('/settings', { method: 'PATCH', body: patch }),
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
  return useQuery({ queryKey: ['mcp-tokens'], queryFn: () => api<{ tokens: McpToken[] }>('/mcp/tokens'), select: (d) => d.tokens });
}

export function useMcpActivity(limit = 8) {
  return useQuery({ queryKey: ['mcp-activity', limit], queryFn: () => api<{ activity: McpActivityEntry[] }>(`/mcp/activity?limit=${limit}`), select: (d) => d.activity });
}

export function useCreateMcpToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; kind: 'personal' | 'service'; scopes: McpScope[] }) => api<CreatedMcpToken>('/mcp/tokens', { method: 'POST', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['mcp-tokens'] }),
  });
}

export function useRevokeMcpToken() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (id: number) => api<undefined>(`/mcp/tokens/${id}`, { method: 'DELETE' }), onSuccess: () => client.invalidateQueries({ queryKey: ['mcp-tokens'] }) });
}

export type McpClient = 'claude-code' | 'claude-code-project' | 'cursor' | 'generic';

/** Ready-to-paste MCP client configs. */
export function clientSnippet(kind: McpClient, url: string, token = '<your token>'): string {
  if (kind === 'claude-code') return `claude mcp add --transport http --scope user asyncup ${url} --header "Authorization: Bearer ${token}"`;
  // A project's .mcp.json is committed, so each person keeps their own token in the environment.
  if (kind === 'claude-code-project') {
    return JSON.stringify({ mcpServers: { asyncup: { type: 'http', url, headers: { Authorization: 'Bearer ${ASYNCUP_TOKEN}' } } } }, null, 2);
  }
  if (kind === 'generic') return `POST ${url}\nAuthorization: Bearer ${token}\nContent-Type: application/json\nAccept: application/json, text/event-stream`;
  return JSON.stringify({ mcpServers: { asyncup: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}
