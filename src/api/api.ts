import express, { type Express, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { DateTime } from 'luxon';
import { runProgress } from '../core/progress.js';
import type { SettingsService } from '../core/settings.js';
import { standupQuestions, type Standup } from '../core/types.js';
import type { Repo } from '../db/repo.js';
import { resolvePrincipal, type Principal } from './principal.js';

/**
 * JSON API under /api/v1 — the front door the v2 web app uses. Chat commands
 * and the API call the same core functions; this layer only shapes JSON and
 * enforces who may see what.
 */
export interface ApiDeps {
  repo: Repo;
  settings: SettingsService;
  secretKey: string;
  operatorToken: string;
  tenantId: string;
  now?: () => DateTime;
}

type ApiRequest = Request & { principal: Principal };

/** Set by the auth middleware; read by every route (param-typed requests included). */
function principalOf(req: Request<any>): Principal {
  return (req as unknown as ApiRequest).principal;
}

/** Browser sessions must prove the request came from our own front-end. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'asyncup';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Every error the API returns has the same shape: `{ error: { code, message, field? } }`. */
export function apiError(res: Response, status: number, code: string, message: string, field?: string): void {
  res.status(status).json({ error: { code, message, ...(field ? { field } : {}) } });
}

function isoDays(standup: Standup): string[] {
  return standup.days.split(',').filter(Boolean);
}

async function summarise(repo: Repo, s: Standup, now: DateTime, manage: boolean) {
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
      days: isoDays(s),
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

function canManage(p: Principal, standupId: number): boolean {
  return p.kind === 'admin' || p.managedStandupIds.includes(standupId);
}

/** Admins see the tenant; everyone else sees what they administer or belong to. */
async function visibleStandups(repo: Repo, p: Principal): Promise<Standup[]> {
  if (p.kind === 'admin') return repo.listStandupsForTenant(p.tenantId);
  const userName = p.user?.userName;
  if (!userName) return [];
  const byId = new Map<number, Standup>();
  for (const s of [...(await repo.listStandupsAdministeredBy(userName)), ...(await repo.listStandupsForUser(userName))]) {
    if (s.tenantId === p.tenantId) byId.set(s.id, s);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function registerApi(app: Express, deps: ApiDeps): void {
  const { repo } = deps;
  const now = deps.now ?? (() => DateTime.utc());
  const api = express.Router();

  // Polled by the app every few seconds per open page, so roomier than the
  // credential endpoints' limiter — still a brake on token guessing.
  api.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));

  api.use(async (req, res, next) => {
    const resolved = await resolvePrincipal(req, deps);
    if ('error' in resolved) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      apiError(
        res,
        401,
        resolved.error,
        resolved.error === 'bad_token' ? 'The bearer token is not valid.' : 'Sign in, or send a bearer token.',
      );
      return;
    }
    if (resolved.principal.via === 'session' && !SAFE_METHODS.has(req.method) && req.header(CSRF_HEADER) !== CSRF_VALUE) {
      apiError(res, 403, 'csrf', `Browser requests that change state must send ${CSRF_HEADER}: ${CSRF_VALUE}.`);
      return;
    }
    (req as unknown as ApiRequest).principal = resolved.principal;
    next();
  });

  api.get('/me', (req, res) => {
    const p = principalOf(req);
    res.json({ kind: p.kind, via: p.via, tenantId: p.tenantId, user: p.user, managedStandupIds: p.managedStandupIds });
  });

  api.get('/standups', async (req, res) => {
    const p = principalOf(req);
    const standups = [];
    for (const s of await visibleStandups(repo, p)) standups.push(await summarise(repo, s, now(), canManage(p, s.id)));
    res.json({ standups });
  });

  api.get('/standups/:id', async (req, res) => {
    const p = principalOf(req);
    const standup = await repo.getStandupById(Number(req.params.id));
    if (!standup || standup.tenantId !== p.tenantId) {
      apiError(res, 404, 'not_found', 'No such standup.');
      return;
    }
    const participants = await repo.listParticipants(standup.id);
    const visible =
      canManage(p, standup.id) || (!!p.user?.userName && participants.some((x) => x.userName === p.user!.userName));
    if (!visible) {
      apiError(res, 404, 'not_found', 'No such standup.');
      return;
    }
    const summary = await summarise(repo, standup, now(), canManage(p, standup.id));
    res.json({
      ...summary,
      participants: participants.map((x) => ({
        userName: x.userName,
        displayName: x.displayName,
        mandatory: x.mandatory,
        timezone: x.timezone,
        onVacation: x.onVacation,
      })),
      admins: (await repo.listAdmins(standup.id)).map((a) => ({ userName: a.userName, displayName: a.displayName })),
    });
  });

  api.use((_req, res) => apiError(res, 404, 'not_found', 'No such API route.'));
  app.use('/api/v1', api);
}
