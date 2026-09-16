import type { Request, Response } from 'express';
import type { DateTime } from 'luxon';
import type { ChatClientFactory } from '../adapters/gchat/adapter.js';
import type { SamlBroker, SamlConfig } from '../auth/saml.js';
import type { ChatAdapter } from '../core/adapter.js';
import type { BlockerService } from '../core/blocker-service.js';
import type { WebhookNotifier } from '../core/webhooks.js';
import { runProgress } from '../core/progress.js';
import type { Scheduler } from '../core/scheduler.js';
import type { SettingsService } from '../core/settings.js';
import { standupQuestions, type Standup } from '../core/types.js';
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
  webhooks: WebhookNotifier;
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

export function canManage(p: Principal, standupId: number): boolean {
  return p.kind === 'admin' || p.managedStandupIds.includes(standupId);
}

/** Admins see the tenant; everyone else sees what they administer or belong to. */
export async function visibleStandups(repo: Repo, p: Principal): Promise<Standup[]> {
  if (p.kind === 'admin') return repo.listStandupsForTenant(p.tenantId);
  const userName = p.user?.userName;
  if (!userName) return [];
  const byId = new Map<number, Standup>();
  for (const s of [...(await repo.listStandupsAdministeredBy(userName)), ...(await repo.listStandupsForUser(userName))]) {
    if (s.tenantId === p.tenantId) byId.set(s.id, s);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Resolve `:id` to a standup the caller may see, or answer the request:
 * 404 when it does not exist, belongs to another tenant or is invisible;
 * 403 when `manage` is required and the caller only belongs to it.
 */
export async function loadStandup(
  ctx: ApiContext,
  req: Request<any>,
  res: Response,
  opts: { manage?: boolean } = {},
): Promise<Standup | null> {
  const p = principalOf(req);
  const standup = await ctx.repo.getStandupById(Number(req.params.id));
  if (!standup || standup.tenantId !== p.tenantId) {
    apiError(res, 404, 'not_found', 'No such standup.');
    return null;
  }
  const manage = canManage(p, standup.id);
  if (!manage) {
    const userName = p.user?.userName;
    const member = !!userName && (await ctx.repo.listParticipants(standup.id)).some((x) => x.userName === userName);
    if (!member) {
      apiError(res, 404, 'not_found', 'No such standup.');
      return null;
    }
    if (opts.manage) {
      apiError(res, 403, 'forbidden', 'Only admins and this standup’s managers can do that.');
      return null;
    }
  }
  return standup;
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
      days: s.days.split(',').filter(Boolean),
      reminderMinutesBefore: s.reminderMinutesBefore,
    },
    questions: standupQuestions(s),
    mood: { enabled: s.moodEnabled, anonymous: s.moodAnonymous },
    digestEnabled: s.digestEnabled,
    escalation: {
      afterDays: s.escalateAfterDays,
      contact: s.escalateUserName ? { userName: s.escalateUserName, displayName: s.escalateDisplayName } : null,
    },
    webhook: { configured: !!s.webhookUrl },
    people: { total: participants.length, mandatory: participants.filter((p) => p.mandatory).length },
    today,
    permissions: { manage },
  };
}
