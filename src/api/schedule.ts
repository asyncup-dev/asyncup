import type { Request, Response, Router } from 'express';
import { AWAY_LABEL, describeWorkingDays, type Actor } from '../core/schedule.js';
import type { Principal } from './principal.js';
import { apiError, canManage, principalOf, type ApiContext } from './shared.js';

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

  /** Whether the caller manages a standup this person is on (workspace admins manage everyone). */
  const managerOf = async (p: Principal, userName: string): Promise<boolean> => {
    if (p.kind === 'admin') return true;
    for (const s of await repo.listStandupsForUser(userName)) if (canManage(p, s.id)) return true;
    return false;
  };

  const actorFor = (p: Principal, target: string, manager: boolean): Actor => ({
    userName: p.user?.userName ?? 'operator',
    displayName: p.user?.name ?? 'Operator',
    self: p.user?.userName === target,
    manager,
  });

  const view = async (userName: string, displayName: string, zone: string) => {
    const workingDays = await repo.getUserWorkingDays(userName);
    const standups = await repo.listStandupsForUser(userName);
    return {
      userName,
      displayName,
      workingDays,
      workingDaysLabel: describeWorkingDays(workingDays),
      policies: standups.map((s) => ({ standupId: s.id, name: s.name, timeOffPolicy: s.timeOffPolicy })),
      overrides: (await ctx.schedule!.listUpcoming(userName, zone)).map(overrideView),
    };
  };

  const zoneFor = async (userName: string) => (await repo.listStandupsForUser(userName))[0]?.timezone ?? 'UTC';

  const datesFrom = (body: any, res: Response): string[] | null => {
    const raw: unknown[] = Array.isArray(body.dates) ? body.dates : body.date ? [body.date] : [];
    if (body.from && body.to) {
      const from = String(body.from);
      const to = String(body.to);
      if (!ISO.test(from) || !ISO.test(to) || to < from) {
        apiError(res, 400, 'invalid', 'from/to must be ISO dates with from ≤ to.', 'from');
        return null;
      }
      const out: string[] = [];
      for (let d = new Date(from); d.toISOString().slice(0, 10) <= to && out.length <= 31; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
      raw.push(...out);
    }
    const dates = [...new Set(raw.map(String))].sort();
    if (dates.length === 0 || dates.some((d) => !ISO.test(d))) {
      apiError(res, 400, 'invalid', 'Give date, dates[] or from/to as ISO dates.', 'dates');
      return null;
    }
    if (dates.length > 31) {
      apiError(res, 400, 'invalid', 'At most 31 days at a time.', 'dates');
      return null;
    }
    return dates;
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
    res.json(await view(me.userName, me.displayName, await zoneFor(me.userName)));
  });

  api.patch('/me/schedule', async (req, res) => {
    const svc = schedule(res);
    if (!svc) return;
    const me = self(req, res);
    if (!me) return;
    const p = principalOf(req);
    const result = await svc.setWorkingDays(me, String(req.body?.workingDays ?? 'reset'), actorFor(p, me.userName, await managerOf(p, me.userName)), 'console');
    if (!result.ok) {
      apiError(res, 400, 'invalid', result.message, 'workingDays');
      return;
    }
    res.json(await view(me.userName, me.displayName, await zoneFor(me.userName)));
  });

  api.post('/me/overrides', async (req, res) => {
    const svc = schedule(res);
    if (!svc) return;
    const me = self(req, res);
    if (!me) return;
    const dates = datesFrom(req.body ?? {}, res);
    if (!dates) return;
    const p = principalOf(req);
    reply(res, await svc.setOverride({ target: me, dates, working: req.body?.working === true, reason: String(req.body?.reason ?? '').slice(0, 200), actor: actorFor(p, me.userName, await managerOf(p, me.userName)), channel: 'console' }));
  });

  api.delete('/me/overrides/:date', async (req, res) => {
    const svc = schedule(res);
    if (!svc) return;
    const me = self(req, res);
    if (!me) return;
    const p = principalOf(req);
    reply(res, await svc.cancelOverride(me, String(req.params.date), actorFor(p, me.userName, await managerOf(p, me.userName))));
  });

  // ---- someone else's schedule (managers and admins)

  const target = async (req: Request<any>, res: Response) => {
    const userName = String(req.params.userName);
    const p = principalOf(req);
    if (!(await managerOf(p, userName))) {
      apiError(res, 403, 'forbidden', 'Only admins and this person’s managers can do that.');
      return null;
    }
    const roster = await repo.listStandupsForUser(userName);
    const displayName = roster.length ? (await repo.listParticipants(roster[0]!.id)).find((x) => x.userName === userName)?.displayName ?? userName : userName;
    return { userName, displayName, actor: actorFor(p, userName, true) };
  };

  api.get('/people/:userName/schedule', async (req, res) => {
    if (!schedule(res)) return;
    const t = await target(req, res);
    if (!t) return;
    res.json(await view(t.userName, t.displayName, await zoneFor(t.userName)));
  });

  api.patch('/people/:userName/schedule', async (req, res) => {
    const svc = schedule(res);
    if (!svc) return;
    const t = await target(req, res);
    if (!t) return;
    const result = await svc.setWorkingDays(t, String(req.body?.workingDays ?? 'reset'), t.actor, 'console');
    if (!result.ok) {
      apiError(res, 400, 'invalid', result.message, 'workingDays');
      return;
    }
    res.json(await view(t.userName, t.displayName, await zoneFor(t.userName)));
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
    reply(res, await svc.cancelOverride(t, String(req.params.date), t.actor));
  });

  // ---- approvals

  api.get('/requests', async (req, res) => {
    if (!schedule(res)) return;
    const p = principalOf(req);
    if (p.kind === 'member') {
      apiError(res, 403, 'forbidden', 'Only admins and managers see requests.');
      return;
    }
    let names: string[] | undefined;
    if (p.kind === 'manager') {
      names = [];
      for (const id of p.managedStandupIds) for (const x of await repo.listParticipants(id)) names.push(x.userName);
    }
    res.json({ requests: (await repo.listPendingOverrides(names)).map(overrideView) });
  });

  for (const decision of ['approve', 'decline'] as const) {
    api.post(`/requests/:id/${decision}`, async (req, res) => {
      const svc = schedule(res);
      if (!svc) return;
      const p = principalOf(req);
      if (p.kind === 'member') {
        apiError(res, 403, 'forbidden', 'Only admins and managers decide requests.');
        return;
      }
      const ids = String(req.params.id).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const note = req.body?.note ? String(req.body.note).slice(0, 200) : null;
      const result = await svc.decide(ids, decision === 'approve', { userName: p.user?.userName ?? 'operator', displayName: p.user?.name ?? 'Operator', admin: p.kind === 'admin' }, note);
      if (!result.ok) {
        apiError(res, 409, 'refused', result.message);
        return;
      }
      res.json({ ok: true, message: result.message });
    });
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function overrideView(o: { id: number; userName: string; displayName: string; date: string; working: boolean; reason: string; status: string; setByDisplayName: string; channel: string; decidedByDisplayName: string | null; decisionNote: string | null; createdAt: string }) {
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
