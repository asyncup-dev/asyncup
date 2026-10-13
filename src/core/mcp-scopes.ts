/**
 * What an MCP token may do. `read` covers every read tool; the write scopes
 * are only meaningful on personal tokens, which act as their owner.
 */
export const MCP_SCOPES = ['read', 'blockers:write', 'submit', 'schedule', 'manage'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const MCP_SCOPE_HELP: Record<McpScope, string> = {
  read: 'List standups, runs, blockers, the team, insights and schedules the owner can see, and the owner’s own standups.',
  'blockers:write': 'Acknowledge, update and resolve blockers as the owner.',
  submit: 'Submit or edit the owner\'s own standup answers, or skip today.',
  schedule: 'Set the owner\'s week, days off, timezone and vacation, do the same for people the owner manages, and decide time-off requests.',
  manage: 'Start today\'s run and nudge people still expected, on standups the owner manages.',
};

/** Parse a comma or space separated list, dropping unknowns and duplicates. */
export function parseScopes(raw: string): McpScope[] {
  const out: McpScope[] = [];
  for (const s of raw.split(/[\s,]+/)) if (MCP_SCOPES.includes(s as McpScope) && !out.includes(s as McpScope)) out.push(s as McpScope);
  return out;
}
