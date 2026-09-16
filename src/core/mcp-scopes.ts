/**
 * What an MCP token may do. `read` covers every read tool; the write scopes
 * are only meaningful on personal tokens, which act as their owner.
 */
export const MCP_SCOPES = ['read', 'blockers:write', 'submit'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const MCP_SCOPE_HELP: Record<McpScope, string> = {
  read: 'List standups, runs, blockers, the team and insights the owner can see.',
  'blockers:write': 'Acknowledge, update and resolve blockers as the owner.',
  submit: 'Submit or edit the owner\'s own standup answers.',
};

/** Parse a comma or space separated list, dropping unknowns and duplicates. */
export function parseScopes(raw: string): McpScope[] {
  const out: McpScope[] = [];
  for (const s of raw.split(/[\s,]+/)) if (MCP_SCOPES.includes(s as McpScope) && !out.includes(s as McpScope)) out.push(s as McpScope);
  return out;
}
