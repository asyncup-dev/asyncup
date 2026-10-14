import type { Request, Response } from 'express';
import type { DateTime } from 'luxon';
import type { ChatClientFactory } from '../adapters/gchat/adapter.js';
import type { SamlBroker, SamlConfig } from '../auth/saml.js';
import type { ChatAdapter } from '../core/adapter.js';
import { can, standupsWith, type Permission } from '../core/permissions.js';
import type { BlockerService } from '../core/blocker-service.js';
import type { WebhookNotifier } from '../core/webhooks.js';
import { runProgress } from '../core/progress.js';
import type { Scheduler } from '../core/scheduler.js';
import type { SettingsService } from '../core/settings.js';
import type { StandupService } from '../core/standup-service.js';
import type { RosterSync } from '../core/roster-sync.js';
import type { ScheduleService } from '../core/schedule.js';
import { standupQuestions, type Standup, type Weekday } from '../core/types.js';
import type { Repo } from '../db/repo.js';
import type { Principal } from './principal.js';

export type ApiRequest = Request & { principal: Principal };

/** Set by the auth middleware; read by every route (param-typed requests included). */
export function principalOf(req: Request<any>): Principal {
  return (req as unknown as ApiRequest).principal;
}

/** Browser sessions must prove the request came from our own front-end. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'asyncup';

/** Every error the API returns has the same shape: `{ error: { code, message, field? } }`. */
export function apiError(res: Response, status: number, code: string, message: string, field?: string): void {
  res.status(status).json({ error: { code, message, ...(field ? { field } : {}) } });
}

export interface ApiContext {
  repo: Repo;
  settings: SettingsService;
  scheduler: Scheduler;
  adapter: ChatAdapter;
  blockers: BlockerService;
  /** Submissions and skips; null when the host was built without it. */
  service: StandupService | null;
  /** Personal weeks, days off and approvals; null when the host was built without it. */
  schedule: ScheduleService | null;
  /** Rosters drawn from a Google Group; null when the host was built without it. */
  roster: RosterSync | null;
  webhooks: WebhookNotifier;
  /** The key a standup's webhooks are signed with; null when the host was built without one. */
  webhookSecret: ((standupId: number) => string) | null;
  /** Builds a Chat API client for verification calls (tests inject a fake). */
  chatClientFactory: ChatClientFactory;
  samlBroker: (config: SamlConfig) => SamlBroker;
  /** Outbound HTTP for reachability checks (tests inject a fake). */
  externalFetch: typeof fetch;
  now: () => DateTime;
}

/** Clamp an integer query value into [min, max], falling back when absent or junk. */
export function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Math.min(Math.max(Number.isInteger(n) ? n : fallback, min), max);
}

/** Whether the caller holds a permission across the workspace, or on this standup. */
export function allowed(p: Principal, permission: Permission, standupId?: number): boolean {
  return can(p.access, permission, standupId);
}

/** The standups the caller may see, in the caller's tenant. */
export async function visibleStandups(repo: Repo, p: Principal): Promise<Standup[]> {
  if (p.access.workspace.has('standups.view')) return repo.listStandupsForTenant(p.tenantId);
  const found: Standup[] = [];
  for (const id of standupsWith(p.access, 'standups.view')) {
    const s = await repo.getStandupById(id);
    if (s?.tenantId === p.tenantId) found.push(s);
  }
  return found.sort((a, b) => a.id - b.id);
}

/** A standup the caller may see, and whether they may configure it. */
export async function findVisibleStandup(
  repo: Repo,
  p: Principal,
  id: number,
): Promise<{ standup: Standup; manage: boolean } | null> {
  const standup = await repo.getStandupById(id);
  if (!standup || standup.tenantId !== p.tenantId || !allowed(p, 'standups.view', standup.id)) return null;
  return { standup, manage: allowed(p, 'standups.configure', standup.id) };
}

/**
 * Resolve `:id` to a standup the caller may see, or answer the request:
 * 404 when it does not exist, belongs to another tenant or is invisible;
 * 403 when the caller lacks `need` on it.
 */
export async function loadStandup(
  ctx: ApiContext,
  req: Request<any>,
  res: Response,
  opts: { need?: Permission } = {},
): Promise<Standup | null> {
  const p = principalOf(req);
  const found = await findVisibleStandup(ctx.repo, p, Number(req.params.id));
  if (!found) {
    apiError(res, 404, 'not_found', 'No such standup.');
    return null;
  }
  if (opts.need && !allowed(p, opts.need, found.standup.id)) {
    apiError(res, 403, 'forbidden', 'Only admins and this standup’s managers can do that.');
    return null;
  }
  return found.standup;
}

/** The standup's days; stored only through parseDays, so every entry is a weekday. */
export function standupDays(s: Standup): Weekday[] {
  return s.days.split(',').filter(Boolean) as Weekday[];
}

export async function summarise(repo: Repo, s: Standup, now: DateTime, manage: boolean) {
  const participants = await repo.listParticipants(s.id);
  const date = now.setZone(s.timezone).toISODate()!;
  const run = await repo.getRun(s.id, date);
  let today: {
    date: string;
    status: 'open' | 'closed' | null;
    submitted: number;
    expected: number;
    missing: { userName: string; displayName: string }[];
  } = { date, status: null, submitted: 0, expected: 0, missing: [] };
  if (run) {
    const progress = runProgress(await repo.listRunParticipants(run.id), await repo.listSubmissions(run.id));
    today = {
      date,
      status: run.status,
      submitted: progress.submitted,
      expected: progress.expected,
      missing: progress.missingMandatory.map((p) => ({ userName: p.userName, displayName: p.displayName })),
    };
  }
  return {
    id: s.id,
    name: s.name,
    spaceName: s.spaceName,
    active: s.active,
    schedule: {
      promptTime: s.promptTime,
      deadlineTime: s.deadlineTime,
      timezone: s.timezone,
      days: standupDays(s),
      reminderMinutesBefore: s.reminderMinutesBefore,
    },
    questions: standupQuestions(s),
    mood: { enabled: s.moodEnabled, anonymous: s.moodAnonymous },
    digestEnabled: s.digestEnabled,
    timeOffPolicy: s.timeOffPolicy,
    escalation: {
      afterDays: s.escalateAfterDays,
      contact: s.escalateUserName ? { userName: s.escalateUserName, displayName: s.escalateDisplayName } : null,
    },
    webhook: { configured: !!s.webhookUrl },
    roster: { group: s.rosterGroup, syncedAt: s.rosterSyncedAt, error: s.rosterSyncError },
    people: { total: participants.length, mandatory: participants.filter((p) => p.mandatory).length },
    today,
    permissions: { manage },
  };
}
