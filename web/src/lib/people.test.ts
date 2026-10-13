import { describe, expect, it } from 'vitest';
import { ageOf, roleOf } from './people';
import { clientSnippet } from './settings';

describe('people helpers', () => {
  it('measures blocker age from a date or an instant', () => {
    const now = new Date('2026-09-16T10:00:00Z');
    expect(ageOf('2026-09-13', now)).toBe('3 days');
    expect(ageOf('2026-09-15', now)).toBe('1 day');
    expect(ageOf('2026-09-16T05:00:00Z', now)).toBe('5 hours');
    expect(ageOf('2026-09-16T09:30:00Z', now)).toBe('0 hours');
  });

  it('derives the role from standup admin flags', () => {
    const base = { userName: 'users/1', displayName: 'A', email: null, timezone: null, onVacation: false, workingDays: null, workingDaysLabel: 'Follows the standup' };
    expect(roleOf({ ...base, standups: [{ id: 1, name: 'x', mandatory: true, admin: true }] })).toBe('Manager');
    expect(roleOf({ ...base, standups: [] })).toBe('Member');
  });

  it('builds client snippets', () => {
    expect(JSON.parse(clientSnippet('claude-desktop', 'https://x/mcp', 'amcp_1'))).toEqual({ mcpServers: { asyncup: { url: 'https://x/mcp', headers: { Authorization: 'Bearer amcp_1' } } } });
    expect(clientSnippet('cursor', 'https://x/mcp')).toContain('<your token>');
    expect(clientSnippet('claude-code', 'https://x/mcp', 't')).toBe('claude mcp add --transport http asyncup https://x/mcp --header "Authorization: Bearer t"');
    expect(clientSnippet('generic', 'https://x/mcp', 't')).toContain('Authorization: Bearer t');
  });
});
