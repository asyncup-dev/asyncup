import type { Request, Response, Router } from 'express';
import { AWAY_LABEL, describeWorkingDays, isIsoDate, type Actor, type ScheduleService } from '../core/schedule.js';
import type { ScheduleOverride } from '../core/types.js';
import type { Repo } from '../db/repo.js';
import type { Principal } from './principal.js';
import { canSomewhere, standupsWith } from '../core/permissions.js';
import { allowed, apiError, principalOf, standupDays, type ApiContext } from './shared.js';

/** Whether the caller manages schedules on a standup this person is on, or across the workspace. */
export async function managesPerson(repo: Repo, p: Principal, userName: string): Promise<boolean> {
  if (allowed(p, 'schedules.manage')) return true;
  for (const s of await repo.listStandupsForUser(userName)) if (allowed(p, 'schedules.manage', s.id)) return true;
  return false;
}

/** The caller as a schedule actor; the service decides what they may change. */
export function actorFor(p: Principal): Actor {
  return { userName: p.user?.userName ?? 'operator', displayName: p.user?.name ?? 'Operator', admin: allowed(p, 'schedules.manage') };
}

/** A person's display name from any roster they are on, else their id. */
export async function displayNameOf(repo: Repo, userName: string): Promise<string> {
  const roster = await repo.listStandupsForUser(userName);
  return roster.length ? ((await repo.listParticipants(roster[0]!.id)).find((x) => x.userName === userName)?.displayName ?? userName) : userName;
}

/**
 * The schedule view the console and the MCP tools share. `visible` limits the
 * per-standup days to the standups a manager looking at someone manages.
 */
export async function scheduleView(repo: Repo, schedule: ScheduleService, userName: string, displayName: string, visible: (standupId: number) => boolean = () => true) {
  const workingDays = await repo.getUserWorkingDays(userName);
  const standups = await repo.listStandupsForUser(userName);
  const zone = standups[0]?.timezone ?? 'UTC';
  const days = new Map<number, string | null>();
  for (const s of standups) days.set(s.id, (await repo.listParticipants(s.id)).find((p) => p.userName === userName)?.workingDays ?? null);
  return {
    userName,
    displayName,
    workingDays,
    workingDaysLabel: describeWorkingDays(workingDays),
    standups: standups.filter((s) => visible(s.id)).map((s) => ({
      standupId: s.id,
      name: s.name,
      days: standupDays(s),
      workingDays: days.get(s.id) ?? null,
      workingDaysLabel: describeWorkingDays(days.get(s.id) ?? null),
      timeOffPolicy: s.timeOffPolicy,
    })),
    policies: standups.map((s) => ({ standupId: s.id, name: s.name, timeOffPolicy: s.timeOffPolicy })),
    overrides: (await schedule.listUpcoming(userName, zone)).map(overrideView),
  };
}

/** Which standup a days change is for: `standupId` from the body, else every standup (deprecated). */
export function daysScope(body: any): number | 'all' | null {
  const id = body?.standupId;
  if (id === undefined || id === null) return 'all';
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Standups the caller manages schedules on, for someone else's view. */
export function managedBy(p: Principal): (standupId: number) => boolean {
  return (id) => allowed(p, 'schedules.manage', id);
}

/**
 * Personal weeks, days off and time-off approvals — the console's side of
 * what the Chat commands `off`, `working` and `days` do.
 */
export function registerScheduleRoutes(api: Router, ctx: ApiContext): void {
  const { repo } = ctx;

  const schedule = (res: Response) => {
    if (!ctx.schedule) apiError(res, 503, 'unavailable', 'Personal schedules are not available on this install.');
    return ctx.schedule;
  };

  const self = (req: Request<any>, res: Response): { userName: string; displayName: string } | null => {
    const user = principalOf(req).user;
    if (!user?.userName) {
      apiError(res, 409, 'not_linked', 'This account is not linked to a Google Chat identity yet.');
      return null;
    }
    return { userName: user.userName, displayName: user.name };
  };

  const managerOf = (p: Principal, userName: string) => managesPerson(repo, p, userName);
  const view = (userName: string, displayName: string, visible?: (standupId: number) => boolean) => scheduleView(repo, ctx.schedule!, userName, displayName, visible);

  const setDays = async (req: Request<any>, res: Response, who: { userName: string; displayName: string }, actor: Actor, visible?: (standupId: number) => boolean) => {
    const scope = daysScope(req.body);
    if (scope === null) {
      apiError(res, 400, 'invalid', 'standupId must be a positive whole number.', 'standupId');
      return;
    }
    const result = await ctx.schedule!.setWorkingDays(who, String(req.body?.workingDays ?? 'reset'), actor, 'console', scope);
    if (!result.ok) {
      apiError(res, 400, 'invalid', result.message, 'workingDays');
      return;
    }
    res.json(await view(who.userName, who.displayName, visible));
  };

  const datesFrom = (body: any, res: Response): string[] | null => {
    const raw: unknown[] = Array.isArray(body.dates) ? body.dates : body.date ? [body.date] : [];
    if (body.from && body.to) {
      const from = String(body.from);
      const to = String(body.to);
      if (!isIsoDate(from) || !isIsoDate(to) || to < from) {
        apiError(res, 400, 'invalid', 'from/to must be ISO dates with from ≤ to.', 'from');
        return null;
      }
      const out: string[] = [];
      for (let d = new Date(from); d.toISOString().slice(0, 10) <= to && out.length <= 31; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
      raw.push(...out);
    }
    const dates = [...new Set(raw.map(String))].sort();
    if (dates.length === 0 || dates.some((d) => !isIsoDate(d))) {
      apiError(res, 400, 'invalid', 'Give date, dates[] or from/to as ISO dates.', 'dates');
      return null;
    }
    if (dates.length > 31) {
      apiError(res, 400, 'invalid', 'At most 31 days at a time.', 'dates');
      return null;
    }
    return dates;
  };

  const dateParam = (req: Request<any>, res: Response): string | null => {
    const date = String(req.params.date);
    if (isIsoDate(date)) return date;
    apiError(res, 400, 'invalid', 'date must be an ISO date (YYYY-MM-DD).', 'date');
    return null;
  };

  const reply = (res: Response, result: { ok: boolean; message: string; status?: string }) => {
    if (!result.ok) {
      apiError(res, 403, 'refused', result.message);
      return;
    }
    res.json({ ok: true, status: result.status, message: result.message });
  };

  // ---- the caller's own schedule

  api.get('/me/schedule', async (req, res) => {
    if (!schedule(res)) return;
    const me = self(req, res);
    if (!me) return;
    res.json(await view(me.userName, me.displayName));
  });

  api.patch('/me/schedule', async (req, res) => {
    if (!schedule(res)) return;
    const me = self(req, res);
    if (!me) return;
    await setDays(req, res, me, actorFor(principalOf(req)));
  });

  api.post('/me/overrides', async (req, res) => {
    const svc = schedule(res);
    if (!svc) return;
    const me = self(req, res);
    if (!me) return;
    const dates = datesFrom(req.body ?? {}, res);
    if (!dates) return;
    const p = principalOf(req);
    reply(res, await svc.setOverride({ target: me, dates, working: req.body?.working === true, reason: String(req.body?.reason ?? '').slice(0, 200), actor: actorFor(p), channel: 'console' }));
  });

  api.delete('/me/overrides/:date', async (req, res) => {
    const svc = schedule(res);
    if (!svc) return;
    const me = self(req, res);
    if (!me) return;
    const date = dateParam(req, res);
    if (!date) return;
    reply(res, await svc.cancelOverride(me, date, actorFor(principalOf(req))));
  });

  // ---- someone else's schedule (managers and admins)

  const target = async (req: Request<any>, res: Response) => {
    const userName = String(req.params.userName);
    const p = principalOf(req);
    if (!(await managerOf(p, userName))) {
      apiError(res, 403, 'forbidden', 'Only admins and this person’s managers can do that.');
      return null;
    }
    return { userName, displayName: await displayNameOf(repo, userName), actor: actorFor(p), visible: managedBy(p) };
  };

  api.get('/people/:userName/schedule', async (req, res) => {
    if (!schedule(res)) return;
    const t = await target(req, res);
    if (!t) return;
    res.json(await view(t.userName, t.displayName, t.visible));
  });

  api.patch('/people/:userName/schedule', async (req, res) => {
    if (!schedule(res)) return;
    const t = await target(req, res);
    if (!t) return;
    await setDays(req, res, { userName: t.userName, displayName: t.displayName }, t.actor, t.visible);
  });

  api.post('/people/:userName/overrides', async (req, res) => {
    const svc = schedule(res);
    if (!svc) return;
    const t = await target(req, res);
    if (!t) return;
    const dates = datesFrom(req.body ?? {}, res);
    if (!dates) return;
    reply(res, await svc.setOverride({ target: t, dates, working: req.body?.working === true, reason: String(req.body?.reason ?? '').slice(0, 200), actor: t.actor, channel: 'console' }));
  });

  api.delete('/people/:userName/overrides/:date', async (req, res) => {
    const svc = schedule(res);
    if (!svc) return;
    const t = await target(req, res);
    if (!t) return;
    const date = dateParam(req, res);
    if (!date) return;
    reply(res, await svc.cancelOverride(t, date, t.actor));
  });

  // ---- approvals

  const reportsOf = async (p: Principal) => (p.user?.userName ? repo.listReportsOf(p.tenantId, p.user.userName) : []);

  api.get('/requests', async (req, res) => {
    if (!schedule(res)) return;
    const p = principalOf(req);
    const reports = await reportsOf(p);
    if (!canSomewhere(p.access, 'schedules.manage') && reports.length === 0) {
      apiError(res, 403, 'forbidden', 'Only admins and managers see requests.');
      return;
    }
    if (allowed(p, 'schedules.manage')) {
      res.json({ requests: (await repo.listPendingOverrides()).map(overrideView) });
      return;
    }
    const managed = new Set<string>();
    for (const id of standupsWith(p.access, 'schedules.manage')) for (const x of await repo.listParticipants(id)) managed.add(x.userName);
    const requests = await repo.listPendingOverrides([...new Set([...managed, ...reports])]);
    // A reporting manager decides days off only, so working requests show only to the person's managers.
    res.json({ requests: requests.filter((o) => managed.has(o.userName) || !o.working).map(overrideView) });
  });

  for (const decision of ['approve', 'decline'] as const) {
    api.post(`/requests/:id/${decision}`, async (req, res) => {
      const svc = schedule(res);
      if (!svc) return;
      const p = principalOf(req);
      if (!canSomewhere(p.access, 'schedules.manage') && (await reportsOf(p)).length === 0) {
        apiError(res, 403, 'forbidden', 'Only admins and managers decide requests.');
        return;
      }
      const ids = String(req.params.id).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const note = req.body?.note ? String(req.body.note).slice(0, 200) : null;
      const result = await svc.decide(ids, decision === 'approve', actorFor(p), note);
      if (!result.ok) {
        apiError(res, 409, 'refused', result.message);
        return;
      }
      res.json({ ok: true, message: result.message });
    });
  }
}

export function overrideView(o: ScheduleOverride) {
  return {
    id: o.id,
    userName: o.userName,
    displayName: o.displayName,
    date: o.date,
    working: o.working,
    reason: o.reason,
    status: o.status,
    label: o.working ? 'Working' : AWAY_LABEL.day_off,
    setBy: o.setByDisplayName,
    channel: o.channel,
    decidedBy: o.decidedByDisplayName,
    decisionNote: o.decisionNote,
    createdAt: o.createdAt,
  };
}
