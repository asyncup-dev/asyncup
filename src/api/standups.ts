import type { Router } from 'express';
import { createStandup } from '../core/create-standup.js';
import { buildCsv } from '../core/export.js';
import { weeklySeries } from '../core/insights.js';
import { runProgress } from '../core/progress.js';
import { validateStandupConfig } from '../core/standup-config.js';
import type { Standup } from '../core/types.js';
import { clampExportDays, LIMITS } from '../core/validation.js';
import { apiError, canManage, clampInt, loadStandup, principalOf, summarise, visibleStandups, type ApiContext } from './shared.js';
import { person, runsView, runView, todayView } from './views.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerStandupRoutes(api: Router, ctx: ApiContext): void {
  const { repo } = ctx;

  api.get('/standups', async (req, res) => {
    const p = principalOf(req);
    const standups = [];
    for (const s of await visibleStandups(repo, p)) standups.push(await summarise(repo, s, ctx.now(), canManage(p, s.id)));
    res.json({ standups });
  });

  const detail = async (standup: Standup, manage: boolean) => ({
    ...(await summarise(repo, standup, ctx.now(), manage)),
    participants: (await repo.listParticipants(standup.id)).map((x) => ({
      userName: x.userName,
      displayName: x.displayName,
      mandatory: x.mandatory,
      timezone: x.timezone,
      onVacation: x.onVacation,
    })),
    admins: (await repo.listAdmins(standup.id)).map(person),
  });

  api.get('/standups/:id', async (req, res) => {
    const standup = await loadStandup(ctx, req, res);
    if (!standup) return;
    res.json(await detail(standup, canManage(principalOf(req), standup.id)));
  });

  // Admins only: the create flow picks a template, a space and a first roster.
  // A signed-in creator becomes the standup's admin; the operator token leaves it open.
  api.post('/standups', async (req, res) => {
    const p = principalOf(req);
    if (p.kind !== 'admin') {
      apiError(res, 403, 'forbidden', 'Only admins can create standups.');
      return;
    }
    const body = req.body ?? {};
    const creator = p.user?.userName ? { userName: p.user.userName, displayName: p.user.name } : null;
    const result = await createStandup(repo, ctx.settings, p.tenantId, body, creator);
    if (!result.ok) {
      if (result.code === 'duplicate') apiError(res, 409, 'duplicate', result.message);
      else apiError(res, 400, 'invalid', result.message, result.field);
      return;
    }
    const runNow = body.runNow === true ? await ctx.scheduler.runNow(result.standup) : null;
    res.status(201).json({ ...(await detail(result.standup, true)), template: result.template?.id ?? null, runNow });
  });

  api.patch('/standups/:id', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { manage: true });
    if (!standup) return;
    const result = await validateStandupConfig(repo, standup, req.body ?? {});
    if (!result.ok) {
      apiError(res, 400, 'invalid', result.message, result.field);
      return;
    }
    await repo.updateStandup(standup.id, result.fields);
    res.json(await summarise(repo, (await repo.getStandupById(standup.id))!, ctx.now(), true));
  });

  for (const [action, active] of [
    ['archive', false],
    ['unarchive', true],
  ] as const) {
    api.post(`/standups/:id/${action}`, async (req, res) => {
      const standup = await loadStandup(ctx, req, res, { manage: true });
      if (!standup) return;
      await repo.updateStandup(standup.id, { active });
      res.json({ id: standup.id, active });
    });
  }

  api.post('/standups/:id/run-now', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { manage: true });
    if (!standup) return;
    res.json({ result: await ctx.scheduler.runNow(standup) });
  });

  // Manual reminder to everyone still expected today. Deliberately does not
  // touch remindedAt, so the scheduled reminder still fires as configured.
  api.post('/standups/:id/nudge', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { manage: true });
    if (!standup) return;
    const run = await repo.getRun(standup.id, ctx.now().setZone(standup.timezone).toISODate()!);
    if (!run || run.status !== 'open') {
      apiError(res, 409, 'no_open_run', 'There is no open run today — use run-now first.');
      return;
    }
    const progress = runProgress(await repo.listRunParticipants(run.id), await repo.listSubmissions(run.id));
    for (const rp of progress.pending) await ctx.adapter.sendReminder(rp.userName, standup, run);
    res.json({ nudged: progress.pending.map(person) });
  });

  api.get('/standups/:id/runs', async (req, res) => {
    const standup = await loadStandup(ctx, req, res);
    if (!standup) return;
    res.json({ runs: await runsView(repo, standup, clampInt(req.query.limit, 14, 1, 90)) });
  });

  api.get('/standups/:id/runs/today', async (req, res) => {
    const standup = await loadStandup(ctx, req, res);
    if (!standup) return;
    res.json(await todayView(repo, standup, ctx.now()));
  });

  api.get('/standups/:id/runs/:date', async (req, res) => {
    const standup = await loadStandup(ctx, req, res);
    if (!standup) return;
    const date = String(req.params.date);
    if (!DATE_RE.test(date)) {
      apiError(res, 400, 'invalid', 'Date must be YYYY-MM-DD.', 'date');
      return;
    }
    const run = await runView(repo, standup, date);
    if (!run) {
      apiError(res, 404, 'not_found', 'No run on that date.');
      return;
    }
    res.json(run);
  });

  api.get('/standups/:id/insights', async (req, res) => {
    const standup = await loadStandup(ctx, req, res);
    if (!standup) return;
    res.json({ weeks: await weeklySeries(repo, standup, ctx.now(), clampInt(req.query.weeks, 8, 1, 26)) });
  });

  api.get('/standups/:id/export.csv', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { manage: true });
    if (!standup) return;
    const days = clampExportDays(req.query.days, 90);
    const today = ctx.now().setZone(standup.timezone);
    const csv = await buildCsv(repo, standup, today.minus({ days }).toISODate()!, today.toISODate()!);
    res
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="standup-${standup.id}-last-${days}d.csv"`)
      .send(csv);
  });

  // --- roster ---

  api.post('/standups/:id/participants', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { manage: true });
    if (!standup) return;
    const body = req.body ?? {};
    const userName = String(body.userName ?? '').trim();
    const displayName = String(body.displayName ?? '').trim();
    if (!userName.startsWith('users/')) {
      apiError(res, 400, 'invalid', 'userName must be a Chat user resource name (users/…).', 'userName');
      return;
    }
    if (!displayName || displayName.length > LIMITS.textMax) {
      apiError(res, 400, 'invalid', 'displayName is required.', 'displayName');
      return;
    }
    await repo.upsertParticipant({ standupId: standup.id, userName, displayName, mandatory: body.mandatory !== false });
    const participant = (await repo.listParticipants(standup.id)).find((x) => x.userName === userName)!;
    res.status(201).json({
      userName,
      displayName: participant.displayName,
      mandatory: participant.mandatory,
      reachable: await ctx.adapter.canDm(userName),
    });
  });

  api.patch('/standups/:id/participants/:userName', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { manage: true });
    if (!standup) return;
    const userName = String(req.params.userName);
    const participant = (await repo.listParticipants(standup.id)).find((x) => x.userName === userName);
    if (!participant) {
      apiError(res, 404, 'not_found', 'Not a participant.');
      return;
    }
    const body = req.body ?? {};
    for (const key of ['mandatory', 'onVacation', 'admin'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') {
        apiError(res, 400, 'invalid', 'Must be true or false.', key);
        return;
      }
    }
    if (body.mandatory !== undefined) await repo.setParticipantMandatory(standup.id, userName, body.mandatory);
    if (body.onVacation !== undefined) await repo.setParticipantVacation(standup.id, userName, body.onVacation);
    if (body.admin === true) await repo.addAdmin(standup.id, userName, participant.displayName);
    if (body.admin === false) {
      const admins = await repo.listAdmins(standup.id);
      if (admins.length === 1 && admins[0]!.userName === userName) {
        apiError(res, 409, 'last_admin', 'A standup must keep at least one admin.');
        return;
      }
      await repo.removeAdmin(standup.id, userName);
    }
    const fresh = (await repo.listParticipants(standup.id)).find((x) => x.userName === userName)!;
    res.json({
      userName,
      displayName: fresh.displayName,
      mandatory: fresh.mandatory,
      onVacation: fresh.onVacation,
      admin: await repo.isAdmin(standup.id, userName),
    });
  });

  api.delete('/standups/:id/participants/:userName', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { manage: true });
    if (!standup) return;
    if (!(await repo.removeParticipant(standup.id, String(req.params.userName)))) {
      apiError(res, 404, 'not_found', 'Not a participant.');
      return;
    }
    res.status(204).end();
  });
}
