import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult, ToolCallback } from '@modelcontextprotocol/server';
import type { DateTime } from 'luxon';
import { z } from 'zod';
import { nudgeToday, skipToday, updateMe, type Refusal } from '../api/actions.js';
import type { Principal } from '../api/principal.js';
import { actorFor, displayNameOf, managesPerson, overrideView, scheduleView } from '../api/schedule.js';
import { allowed, findVisibleStandup, summarise, visibleStandups } from '../api/shared.js';
import { canSomewhere, standupsWith, type Permission } from '../core/permissions.js';
import * as S from '../api/spec/schemas.js';
import { BLOCKER_STATUSES, blockersView, linkedStandupsView, peopleView, runsView, runView, standupDetailView, visibleBlocker } from '../api/views.js';
import type { ChatAdapter } from '../core/adapter.js';
import type { BlockerService } from '../core/blocker-service.js';
import { weeklySeries } from '../core/insights.js';
import { MCP_SCOPES, parseScopes, type McpScope } from '../core/mcp-scopes.js';
import { isIsoDate, type ScheduleService } from '../core/schedule.js';
import type { Scheduler } from '../core/scheduler.js';
import type { StandupService } from '../core/standup-service.js';
import { MOODS, standupQuestions, type McpToken } from '../core/types.js';
import { LIMITS } from '../core/validation.js';
import type { Repo } from '../db/repo.js';

export interface McpToolDeps {
  repo: Repo;
  blockers: BlockerService;
  /** Absent when the server was built without the standup service; submit_answers and skip_today are then not offered. */
  service: StandupService | null;
  /** Absent when the server was built without personal schedules; the schedule tools then refuse. */
  schedule: ScheduleService | null;
  scheduler: Scheduler;
  adapter: ChatAdapter;
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
const ISO_DATE = z.string().refine(isIsoDate, 'Use a real date as YYYY-MM-DD.');

// Outputs that only the MCP tools return; everything else reuses the JSON API's schemas.
const McpMe = S.Me.extend({ scopes: z.array(z.enum(MCP_SCOPES)) });
const Submitted = z.strictObject({ result: z.literal('submitted'), date: z.iso.date() });
const WeekSet = z.strictObject({ message: z.string(), schedule: S.Schedule });

function summariseArgs(args: unknown): string {
  const text = JSON.stringify(args ?? {});
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

function refuse(r: Refusal): never {
  throw new ToolRefused(r.message);
}

/**
 * How a write behaves when the model calls it: `destructive` when it
 * overwrites or withdraws something, `idempotent` when repeating it changes
 * nothing more. Every write may message people in Google Chat.
 */
type WriteHints = { destructive: boolean; idempotent: boolean };

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
        'AsyncUp runs asynchronous standups in Google Chat. Start with get_me to see who this token acts as and what it may do, then list_standups. ' +
        'Read tools return JSON for the standups the token’s owner can see. Write tools act as the owner and may message people in Google Chat. ' +
        'Dates are YYYY-MM-DD in the standup’s timezone; people are Chat user names like users/123.',
    },
  );

  const register = <Args extends z.ZodObject<any>, Out extends z.ZodObject<any>>(
    name: string,
    scope: McpScope,
    config: { title: string; description: string; inputSchema: Args; outputSchema: Out; write?: WriteHints },
    handler: (args: z.infer<Args>) => Promise<z.infer<Out>>,
  ) => {
    if (!scopes.includes(scope)) return;
    const write = config.write;
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema,
        outputSchema: config.outputSchema,
        annotations: {
          title: config.title,
          readOnlyHint: !write,
          destructiveHint: write?.destructive ?? false,
          idempotentHint: write?.idempotent ?? true,
          openWorldHint: !!write,
        },
      },
      (async (args: z.infer<Args>): Promise<CallToolResult> => {
        let ok = true;
        try {
          const result = await handler(args);
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
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

  const visible = async (id: number) => {
    const found = await findVisibleStandup(repo, p, id);
    if (!found) throw new ToolRefused('No such standup.');
    return found;
  };
  const standupFor = async (id: number, need: Permission = 'standups.view') => {
    const found = await visible(id);
    if (!allowed(p, need, id)) throw new ToolRefused('Only admins and this standup’s managers can do that.');
    return found.standup;
  };
  const me = () => {
    if (!p.user?.userName) throw new ToolRefused('This token has no person behind it; this tool needs a personal token.');
    return { userName: p.user.userName, displayName: p.user.name };
  };

  // ---- reads

  register(
    'get_me',
    'read',
    {
      title: 'Who am I',
      description: 'Who this token acts as, their role (admin, manager or member), the standups they manage, and the token’s scopes.',
      inputSchema: z.object({}),
      outputSchema: McpMe,
    },
    async () => ({ kind: p.kind, via: p.via, tenantId: p.tenantId, user: p.user, managedStandupIds: p.managedStandupIds, scopes }),
  );

  register(
    'list_standups',
    'read',
    { title: 'List standups', description: 'Standups the owner can see, each with its schedule, questions and today’s progress.', inputSchema: z.object({}), outputSchema: S.StandupList },
    async () => {
      const standups = [];
      for (const s of await visibleStandups(repo, p)) standups.push(await summarise(repo, s, deps.now(), allowed(p, 'standups.configure', s.id)));
      return { standups };
    },
  );

  register(
    'get_standup',
    'read',
    { title: 'Get a standup', description: 'One standup with its full roster (mandatory, timezone, vacation) and its admins.', inputSchema: z.object({ standupId: ID }), outputSchema: S.StandupDetail },
    async ({ standupId }) => {
      const found = await visible(standupId);
      return standupDetailView(repo, found.standup, deps.now(), found.manage);
    },
  );

  register(
    'get_my_standups',
    'read',
    {
      title: 'My standups',
      description: 'The owner’s own standups: schedule, whether they have answered today, how far the team has got, and a link to the bot’s DM.',
      inputSchema: z.object({}),
      outputSchema: S.LinkedMyStandups,
    },
    async () => linkedStandupsView(repo, me().userName, deps.now()),
  );

  register(
    'list_runs',
    'read',
    {
      title: 'List runs',
      description: 'Recent runs of a standup, newest first, with submitted and expected counts and who is missing.',
      inputSchema: z.object({ standupId: ID, limit: z.number().int().min(1).max(90).default(14) }),
      outputSchema: S.RunList,
    },
    async ({ standupId, limit }) => ({ runs: await runsView(repo, await standupFor(standupId, 'reports.view'), limit) }),
  );

  register(
    'get_run',
    'read',
    {
      title: 'Get a run',
      description: 'One run with every submission and its answers. Omit date for today. Moods are withheld per person when the standup keeps them anonymous.',
      inputSchema: z.object({ standupId: ID, date: ISO_DATE.optional() }),
      outputSchema: S.RunDetail,
    },
    async ({ standupId, date }) => {
      const standup = await standupFor(standupId, 'answers.view');
      const run = await runView(repo, standup, date ?? deps.now().setZone(standup.timezone).toISODate()!);
      if (!run) throw new ToolRefused('No run on that date.');
      return run;
    },
  );

  register(
    'list_blockers',
    'read',
    {
      title: 'List blockers',
      description: 'Blockers across every standup the owner can see, with who is tagged and the updates so far.',
      inputSchema: z.object({ status: z.enum(BLOCKER_STATUSES).default('open'), standupId: ID.optional(), owner: z.string().optional() }),
      outputSchema: S.BlockerList,
    },
    async ({ status, standupId, owner }) => ({ blockers: await blockersView(repo, p, { status, standupId: standupId ?? null, ...(owner ? { owner } : {}) }) }),
  );

  register(
    'get_team',
    'read',
    { title: 'Get the team', description: 'Everyone on a roster the owner can see, with their standups and roles (admins and managers only).', inputSchema: z.object({}), outputSchema: S.Team },
    async () => {
      if (!canSomewhere(p.access, 'people.view')) throw new ToolRefused('Only admins and managers can list the team.');
      return { people: await peopleView(repo, p) };
    },
  );

  register(
    'get_insights',
    'read',
    {
      title: 'Get insights',
      description: 'Weekly participation, mood and blocker series for a standup.',
      inputSchema: z.object({ standupId: ID, weeks: z.number().int().min(1).max(26).default(8) }),
      outputSchema: S.Insights,
    },
    async ({ standupId, weeks }) => ({ weeks: await weeklySeries(repo, await standupFor(standupId, 'reports.view'), deps.now(), weeks) }),
  );

  // ---- blockers

  const blockerFor = async (blockerId: number) => {
    const who = me();
    const blocker = await visibleBlocker(repo, p, blockerId);
    if (!blocker) throw new ToolRefused('No such blocker.');
    return { blocker, me: who };
  };

  register(
    'acknowledge_blocker',
    'blockers:write',
    { title: 'Acknowledge a blocker', description: 'Acknowledge a blocker the owner was tagged on.', inputSchema: z.object({ blockerId: ID }), outputSchema: S.BlockerResult.acknowledge, write: { destructive: false, idempotent: true } },
    async ({ blockerId }) => {
      const a = await blockerFor(blockerId);
      const result = await deps.blockers.acknowledge(a.blocker.id, a.me);
      if (result === 'not_found') throw new ToolRefused('No such open blocker.');
      if (result === 'not_tagged') throw new ToolRefused('Only people tagged on a blocker can acknowledge it.');
      if (result === 'already_acked') throw new ToolRefused('You already acknowledged this blocker.');
      return { result };
    },
  );

  register(
    'update_blocker',
    'blockers:write',
    {
      title: 'Update a blocker',
      description: 'Add a progress note to a blocker; it is posted in the standup’s thread.',
      inputSchema: z.object({ blockerId: ID, text: z.string().trim().min(1).max(LIMITS.textMax) }),
      outputSchema: S.BlockerResult.update,
      write: { destructive: false, idempotent: false },
    },
    async ({ blockerId, text }) => {
      const a = await blockerFor(blockerId);
      const result = await deps.blockers.addUpdate(a.blocker.id, a.me, text);
      if (result === 'not_found') throw new ToolRefused('No such blocker.');
      if (result === 'resolved') throw new ToolRefused('This blocker is already resolved.');
      return { result };
    },
  );

  register(
    'resolve_blocker',
    'blockers:write',
    { title: 'Resolve a blocker', description: 'Resolve a blocker the owner owns, is tagged on, or administers.', inputSchema: z.object({ blockerId: ID }), outputSchema: S.BlockerResult.resolve, write: { destructive: true, idempotent: true } },
    async ({ blockerId }) => {
      const a = await blockerFor(blockerId);
      const result = await deps.blockers.resolve(a.blocker.id, a.me);
      if (result === 'not_found') throw new ToolRefused('No such blocker.');
      if (result === 'already_resolved') throw new ToolRefused('This blocker is already resolved.');
      if (result === 'not_allowed') throw new ToolRefused('Only the owner, tagged people and standup admins can resolve a blocker.');
      return { result };
    },
  );

  // ---- the owner's own standup

  if (deps.service) {
    const service = deps.service;
    register(
      'submit_answers',
      'submit',
      {
        title: 'Submit my answers',
        description: 'Submit, or replace, the owner’s answers for today’s run. answers[] must match the standup’s questions in order (get_standup lists them), and every answer is required: answer a blockers question with "none" when there are none. mood is required when the standup asks for it.',
        inputSchema: z.object({ standupId: ID, answers: z.array(z.string().trim().min(1).max(LIMITS.textMax)).min(1), mood: z.enum(MOODS).nullable().default(null) }),
        outputSchema: Submitted,
        write: { destructive: true, idempotent: true },
      },
      async ({ standupId, answers, mood }) => {
        const who = me();
        const standup = await standupFor(standupId);
        const questions = standupQuestions(standup);
        if (answers.length !== questions.length) throw new ToolRefused(`This standup asks ${questions.length} questions: ${questions.join(' | ')}`);
        if (standup.moodEnabled && !mood) throw new ToolRefused(`This standup asks for a mood: one of ${MOODS.join(', ')}.`);
        const run = await repo.getRun(standup.id, deps.now().setZone(standup.timezone).toISODate()!);
        if (!run) throw new ToolRefused('Today’s run has not opened yet.');
        const result = await service.submit(run.id, who.userName, who.displayName, { answers: questions.map((question, i) => ({ question, answer: answers[i]! })), mood });
        if (!result.ok) throw new ToolRefused(SUBMIT_REASONS[result.reason]);
        return { result: 'submitted' as const, date: run.date };
      },
    );

    register(
      'skip_today',
      'submit',
      { title: 'Skip today', description: 'Skip today’s run of one standup with a one-line reason: no more reminders, the owner shows as away, and the reason is posted in the day’s thread.', inputSchema: z.object({ standupId: ID, reason: z.string().trim().min(1).max(LIMITS.skipNoteMax) }), outputSchema: S.Skipped, write: { destructive: false, idempotent: true } },
      async ({ standupId, reason }) => {
        const who = me();
        const r = await skipToday(repo, service, await standupFor(standupId), who.userName, deps.now(), reason);
        return r.ok ? { result: r.result, date: r.date } : refuse(r);
      },
    );
  }

  // ---- running a standup (managers)

  register(
    'run_standup_now',
    'manage',
    {
      title: 'Start today’s run',
      description: 'Open today’s run of a standup now and prompt everyone expected, instead of waiting for its prompt time.',
      inputSchema: z.object({ standupId: ID }),
      outputSchema: S.RunNow,
      write: { destructive: false, idempotent: true },
    },
    async ({ standupId }) => {
      const standup = await standupFor(standupId, 'standups.configure');
      return { result: await deps.scheduler.runNow(standup) };
    },
  );

  register(
    'nudge_standup',
    'manage',
    {
      title: 'Nudge the team',
      description: 'Send a reminder to everyone still expected in today’s open run. The scheduled reminder still fires as usual.',
      inputSchema: z.object({ standupId: ID }),
      outputSchema: S.Nudged,
      write: { destructive: false, idempotent: false },
    },
    async ({ standupId }) => {
      const standup = await standupFor(standupId, 'standups.configure');
      const r = await nudgeToday(repo, deps.adapter, standup, deps.now());
      return r.ok ? { nudged: r.nudged } : refuse(r);
    },
  );

  // ---- personal schedules: the owner's own, or someone the owner manages

  const schedule = () => {
    if (!deps.schedule) throw new ToolRefused('Personal schedules are not available on this install.');
    return deps.schedule;
  };
  const targetFor = async (userName?: string) => {
    if (!userName || userName === p.user?.userName) {
      const who = me();
      return { ...who, actor: actorFor(p) };
    }
    if (!(await managesPerson(repo, p, userName))) throw new ToolRefused('Only admins and this person’s managers can do that.');
    return { userName, displayName: await displayNameOf(repo, userName), actor: actorFor(p) };
  };
  const expand = (dates: string[] | undefined, from: string | undefined, to: string | undefined): string[] => {
    const out = new Set(dates ?? []);
    if (from && to) {
      if (to < from) throw new ToolRefused('from must be on or before to.');
      for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to && out.size <= 31; d.setUTCDate(d.getUTCDate() + 1)) out.add(d.toISOString().slice(0, 10));
    }
    if (out.size === 0) throw new ToolRefused('Give dates, or from and to.');
    if (out.size > 31) throw new ToolRefused('At most 31 days at a time.');
    return [...out].sort();
  };
  const managerOnly = () => {
    if (!canSomewhere(p.access, 'schedules.manage')) throw new ToolRefused('Only admins and managers can do that.');
  };

  register(
    'get_schedule',
    'read',
    {
      title: 'Get a schedule',
      description: 'A person’s working week, the time-off policy of their standups and their upcoming days off. Omit userName for the owner.',
      inputSchema: z.object({ userName: z.string().optional() }),
      outputSchema: S.Schedule,
    },
    async ({ userName }) => {
      const svc = schedule();
      const t = await targetFor(userName);
      return scheduleView(repo, svc, t.userName, t.displayName);
    },
  );

  register(
    'list_time_off_requests',
    'read',
    { title: 'List time-off requests', description: 'Time-off requests waiting for a decision, for the people the owner manages.', inputSchema: z.object({}), outputSchema: S.TimeOffRequests },
    async () => {
      schedule();
      managerOnly();
      let names: string[] | undefined;
      if (!allowed(p, 'schedules.manage')) {
        names = [];
        for (const id of standupsWith(p.access, 'schedules.manage')) for (const x of await repo.listParticipants(id)) names.push(x.userName);
      }
      return { requests: (await repo.listPendingOverrides(names)).map(overrideView) };
    },
  );

  register(
    'update_my_settings',
    'schedule',
    {
      title: 'Update my settings',
      description: 'Set the owner’s timezone (an IANA name; null follows the standups) and whether they are on vacation across all their standups.',
      inputSchema: z.object({ timezone: z.string().nullable().optional(), onVacation: z.boolean().optional() }),
      outputSchema: S.MySettings,
      write: { destructive: true, idempotent: true },
    },
    async ({ timezone, onVacation }) => {
      const r = await updateMe(repo, me().userName, { timezone, onVacation }, deps.now());
      return r.ok ? { timezone: r.timezone, onVacation: r.onVacation } : refuse(r);
    },
  );

  register(
    'set_working_days',
    'schedule',
    {
      title: 'Set a working week',
      description: 'Set a personal week: "mon-thu", "mon,wed,fri", "adhoc" (only dated working days count) or "reset" to follow the standup. Omit userName for the owner.',
      inputSchema: z.object({ userName: z.string().optional(), workingDays: z.string().trim().min(1) }),
      outputSchema: WeekSet,
      write: { destructive: true, idempotent: true },
    },
    async ({ userName, workingDays }) => {
      const svc = schedule();
      const t = await targetFor(userName);
      const r = await svc.setWorkingDays(t, workingDays, t.actor, 'api');
      if (!r.ok) throw new ToolRefused(r.message);
      return { message: r.message, schedule: await scheduleView(repo, svc, t.userName, t.displayName) };
    },
  );

  register(
    'set_days_off',
    'schedule',
    {
      title: 'Set days off',
      description: 'Mark dates off (or, with working=true, as extra working days) with an optional reason. Subject to the standup’s time-off policy: status says whether it applied or became a request.',
      inputSchema: z.object({ userName: z.string().optional(), dates: z.array(ISO_DATE).max(31).optional(), from: ISO_DATE.optional(), to: ISO_DATE.optional(), working: z.boolean().default(false), reason: z.string().trim().max(200).default('') }),
      outputSchema: S.ScheduleChange,
      write: { destructive: false, idempotent: true },
    },
    async ({ userName, dates, from, to, working, reason }) => {
      const svc = schedule();
      const t = await targetFor(userName);
      const r = await svc.setOverride({ target: t, dates: expand(dates, from, to), working, reason, actor: t.actor, channel: 'api' });
      if (!r.ok) throw new ToolRefused(r.message);
      return r;
    },
  );

  register(
    'cancel_day_off',
    'schedule',
    {
      title: 'Cancel a day off',
      description: 'Withdraw a day off, extra working day or pending request on a date.',
      inputSchema: z.object({ userName: z.string().optional(), date: ISO_DATE }),
      outputSchema: S.ScheduleChange,
      write: { destructive: true, idempotent: false },
    },
    async ({ userName, date }) => {
      const svc = schedule();
      const t = await targetFor(userName);
      const r = await svc.cancelOverride(t, date, t.actor);
      if (!r.ok) throw new ToolRefused(r.message);
      return r;
    },
  );

  register(
    'decide_time_off_request',
    'schedule',
    {
      title: 'Decide a time-off request',
      description: 'Approve or decline one person’s pending time-off request by id (one request can span several dates). A decline note is sent to the person.',
      inputSchema: z.object({ ids: z.array(ID).min(1), approve: z.boolean(), note: z.string().trim().max(200).optional() }),
      outputSchema: S.Decision,
      write: { destructive: true, idempotent: false },
    },
    async ({ ids, approve, note }) => {
      const svc = schedule();
      managerOnly();
      const r = await svc.decide(ids, approve, actorFor(p), note ?? null);
      if (!r.ok) throw new ToolRefused(r.message);
      return { ok: true as const, message: r.message };
    },
  );

  return server;
}

const SUBMIT_REASONS: Record<'run_not_found' | 'not_a_participant' | 'already_submitted', string> = {
  run_not_found: 'Today’s run has not opened yet.',
  not_a_participant: 'You are not on this standup’s roster today.',
  already_submitted: 'Today’s run is closed; your answers can no longer change.',
};
