import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult, ToolCallback } from '@modelcontextprotocol/server';
import type { DateTime } from 'luxon';
import { z } from 'zod';
import type { Principal } from '../api/principal.js';
import { findVisibleStandup, summarise, visibleStandups } from '../api/shared.js';
import { BLOCKER_STATUSES, blockersView, peopleView, runsView, runView, visibleBlocker } from '../api/views.js';
import type { BlockerService } from '../core/blocker-service.js';
import { weeklySeries } from '../core/insights.js';
import { parseScopes, type McpScope } from '../core/mcp-scopes.js';
import type { StandupService } from '../core/standup-service.js';
import { MOODS, standupQuestions, type McpToken } from '../core/types.js';
import { LIMITS } from '../core/validation.js';
import type { Repo } from '../db/repo.js';

export interface McpToolDeps {
  repo: Repo;
  blockers: BlockerService;
  /** Absent when the server was built without the standup service; submit_answers is then not offered. */
  service: StandupService | null;
  now: () => DateTime;
  version: string;
}

/** A tool that refuses is a normal result with isError — clients show the text, the log records the failure. */
class ToolRefused extends Error {
  // Explicit so Bun's function coverage can see it being called.
  constructor(message: string) {
    super(message);
  }
}

const ID = z.number().int().positive();

function summariseArgs(args: unknown): string {
  const text = JSON.stringify(args ?? {});
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

/**
 * One McpServer per request, holding only the tools the token's scopes
 * allow. Every call is logged against the token; the principal decides
 * what the tools can see, exactly as the JSON API would for that person.
 */
export function buildMcpServer(deps: McpToolDeps, token: McpToken, p: Principal): McpServer {
  const { repo } = deps;
  const scopes = parseScopes(token.scopes);
  const server = new McpServer(
    { name: 'asyncup', version: deps.version },
    {
      instructions:
        'AsyncUp runs asynchronous standups in Google Chat. Read tools return JSON for the standups this token’s owner can see. ' +
        'Write tools act as the owner. Dates are YYYY-MM-DD in the standup’s timezone.',
    },
  );

  const register = <Args extends z.ZodObject<any>>(
    name: string,
    scope: McpScope,
    config: { description: string; inputSchema: Args; readOnly: boolean },
    handler: (args: z.infer<Args>) => Promise<unknown>,
  ) => {
    if (!scopes.includes(scope)) return;
    server.registerTool(
      name,
      {
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: { readOnlyHint: config.readOnly, destructiveHint: false },
      },
      (async (args: z.infer<Args>): Promise<CallToolResult> => {
        let ok = true;
        try {
          const result = await handler(args);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          ok = false;
          if (err instanceof ToolRefused) return { content: [{ type: 'text', text: err.message }], isError: true };
          throw err;
        } finally {
          await repo.logMcpActivity({ tokenId: token.id, tool: name, argsSummary: summariseArgs(args), ok, at: deps.now().toUTC().toISO()! });
        }
      }) as ToolCallback<Args>,
    );
  };

  const standupFor = async (id: number) => {
    const found = await findVisibleStandup(repo, p, id);
    if (!found) throw new ToolRefused('No such standup.');
    return found.standup;
  };
  const me = () => {
    if (!p.user?.userName) throw new ToolRefused('This token has no person behind it; write tools need a personal token.');
    return { userName: p.user.userName, displayName: p.user.name };
  };

  register('list_standups', 'read', { description: 'Standups the owner can see, with today’s progress.', inputSchema: z.object({}), readOnly: true }, async () => {
    const standups = [];
    for (const s of await visibleStandups(repo, p)) standups.push(await summarise(repo, s, deps.now(), p.kind === 'admin' || p.managedStandupIds.includes(s.id)));
    return { standups };
  });

  register(
    'list_runs',
    'read',
    { description: 'Recent runs of a standup with submitted/expected counts and who is missing.', inputSchema: z.object({ standupId: ID, limit: z.number().int().min(1).max(90).default(14) }), readOnly: true },
    async ({ standupId, limit }) => ({ runs: await runsView(repo, await standupFor(standupId), limit) }),
  );

  register(
    'get_run',
    'read',
    {
      description: 'One run with every submission and its answers. Omit date for today. Moods are withheld per person when the standup keeps them anonymous.',
      inputSchema: z.object({ standupId: ID, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
      readOnly: true,
    },
    async ({ standupId, date }) => {
      const standup = await standupFor(standupId);
      const run = await runView(repo, standup, date ?? deps.now().setZone(standup.timezone).toISODate()!);
      if (!run) throw new ToolRefused('No run on that date.');
      return run;
    },
  );

  register(
    'list_blockers',
    'read',
    {
      description: 'Blockers across every standup the owner can see, with tags and updates.',
      inputSchema: z.object({ status: z.enum(BLOCKER_STATUSES).default('open'), standupId: ID.optional(), owner: z.string().optional() }),
      readOnly: true,
    },
    async ({ status, standupId, owner }) => ({ blockers: await blockersView(repo, p, { status, standupId: standupId ?? null, ...(owner ? { owner } : {}) }) }),
  );

  register('get_team', 'read', { description: 'Everyone on a roster the owner can see (admins and managers only).', inputSchema: z.object({}), readOnly: true }, async () => {
    if (p.kind === 'member') throw new ToolRefused('Only admins and managers can list the team.');
    return { people: await peopleView(repo, p) };
  });

  register(
    'get_insights',
    'read',
    { description: 'Weekly participation, mood and blocker series for a standup.', inputSchema: z.object({ standupId: ID, weeks: z.number().int().min(1).max(26).default(8) }), readOnly: true },
    async ({ standupId, weeks }) => ({ weeks: await weeklySeries(repo, await standupFor(standupId), deps.now(), weeks) }),
  );

  const blockerFor = async (blockerId: number) => {
    const who = me();
    const blocker = await visibleBlocker(repo, p, blockerId);
    if (!blocker) throw new ToolRefused('No such blocker.');
    return { blocker, me: who };
  };

  register('acknowledge_blocker', 'blockers:write', { description: 'Acknowledge a blocker you were tagged on.', inputSchema: z.object({ blockerId: ID }), readOnly: false }, async ({ blockerId }) => {
    const a = await blockerFor(blockerId);
    const result = await deps.blockers.acknowledge(a.blocker.id, a.me);
    if (result === 'not_found') throw new ToolRefused('No such open blocker.');
    if (result === 'not_tagged') throw new ToolRefused('Only people tagged on a blocker can acknowledge it.');
    if (result === 'already_acked') throw new ToolRefused('You already acknowledged this blocker.');
    return { result };
  });

  register(
    'update_blocker',
    'blockers:write',
    { description: 'Add a progress note to a blocker.', inputSchema: z.object({ blockerId: ID, text: z.string().trim().min(1).max(LIMITS.textMax) }), readOnly: false },
    async ({ blockerId, text }) => {
      const a = await blockerFor(blockerId);
      const result = await deps.blockers.addUpdate(a.blocker.id, a.me, text);
      if (result === 'resolved') throw new ToolRefused('This blocker is already resolved.');
      return { result };
    },
  );

  register('resolve_blocker', 'blockers:write', { description: 'Resolve a blocker you own, are tagged on, or administer.', inputSchema: z.object({ blockerId: ID }), readOnly: false }, async ({ blockerId }) => {
    const a = await blockerFor(blockerId);
    const result = await deps.blockers.resolve(a.blocker.id, a.me);
    if (result === 'already_resolved') throw new ToolRefused('This blocker is already resolved.');
    if (result === 'not_allowed') throw new ToolRefused('Only the owner, tagged people and standup admins can resolve a blocker.');
    return { result };
  });

  if (deps.service) {
    const service = deps.service;
    register(
      'submit_answers',
      'submit',
      {
        description: 'Submit (or edit) your own answers for today’s run. answers[] must match the standup’s questions in order.',
        inputSchema: z.object({ standupId: ID, answers: z.array(z.string().trim().max(LIMITS.textMax)).min(1), mood: z.enum(MOODS).nullable().default(null) }),
        readOnly: false,
      },
      async ({ standupId, answers, mood }) => {
        const who = me();
        const standup = await standupFor(standupId);
        const questions = standupQuestions(standup);
        if (answers.length !== questions.length) throw new ToolRefused(`This standup asks ${questions.length} questions: ${questions.join(' | ')}`);
        const run = await repo.getRun(standup.id, deps.now().setZone(standup.timezone).toISODate()!);
        if (!run) throw new ToolRefused('Today’s run has not opened yet.');
        const result = await service.submit(run.id, who.userName, who.displayName, { answers: questions.map((question, i) => ({ question, answer: answers[i]! })), mood });
        if (!result.ok) throw new ToolRefused(SUBMIT_REASONS[result.reason]);
        return { result: 'submitted', date: run.date };
      },
    );
  }

  return server;
}

const SUBMIT_REASONS: Record<'run_not_found' | 'not_a_participant' | 'already_submitted', string> = {
  run_not_found: 'Today’s run has not opened yet.',
  not_a_participant: 'You are not on this standup’s roster today.',
  already_submitted: 'Today’s run is closed; your answers can no longer change.',
};
