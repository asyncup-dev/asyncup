import type { Router } from 'express';
import { createStandup } from '../core/create-standup.js';
import { nudgeToday } from './actions.js';
import { buildCsv } from '../core/export.js';
import { weeklySeries } from '../core/insights.js';
import { validateStandupConfig } from '../core/standup-config.js';
import type { Standup } from '../core/types.js';
import { clampExportDays, LIMITS } from '../core/validation.js';
import { allowed, apiError, clampInt, loadStandup, principalOf, summarise, visibleStandups, type ApiContext } from './shared.js';
import { runsView, runView, standupDetailView, todayView } from './views.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerStandupRoutes(api: Router, ctx: ApiContext): void {
  const { repo } = ctx;

  api.get('/standups', async (req, res) => {
    const p = principalOf(req);
    const standups = [];
    for (const s of await visibleStandups(repo, p)) standups.push(await summarise(repo, s, ctx.now(), allowed(p, 'standups.configure', s.id)));
    res.json({ standups });
  });

  const detail = (standup: Standup, manage: boolean) => standupDetailView(repo, standup, ctx.now(), manage);

  api.get('/standups/:id', async (req, res) => {
    const standup = await loadStandup(ctx, req, res);
    if (!standup) return;
    res.json(await detail(standup, allowed(principalOf(req), 'standups.configure', standup.id)));
  });

  // Admins only: the create flow picks a template, a space and a first roster.
  // A signed-in creator becomes the standup's admin; the operator token leaves it open.
  api.post('/standups', async (req, res) => {
    const p = principalOf(req);
    if (!allowed(p, 'standups.create')) {
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
    if (result.standup.rosterGroup) await ctx.roster?.sync(result.standup);
    const runNow = body.runNow === true ? await ctx.scheduler.runNow((await repo.getStandupById(result.standup.id))!) : null;
    res.status(201).json({ ...(await detail(result.standup, true)), template: result.template?.id ?? null, runNow });
  });

  api.patch('/standups/:id', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'standups.configure' });
    if (!standup) return;
    const result = await validateStandupConfig(repo, standup, req.body ?? {});
    if (!result.ok) {
      apiError(res, 400, 'invalid', result.message, result.field);
      return;
    }
    await repo.updateStandup(standup.id, result.fields);
    const fresh = (await repo.getStandupById(standup.id))!;
    // A new roster group fills the roster now rather than at the next hourly sync.
    if (fresh.rosterGroup && fresh.rosterGroup !== standup.rosterGroup) await ctx.roster?.sync(fresh);
    res.json(await summarise(repo, (await repo.getStandupById(standup.id))!, ctx.now(), true));
  });

  for (const [action, active] of [
    ['archive', false],
    ['unarchive', true],
  ] as const) {
    api.post(`/standups/:id/${action}`, async (req, res) => {
      const standup = await loadStandup(ctx, req, res, { need: 'standups.archive' });
      if (!standup) return;
      await repo.updateStandup(standup.id, { active });
      res.json({ id: standup.id, active });
    });
  }

  // Workspace admins only, archived first, with the name typed back: three
  // deliberate steps, because this removes the standup's whole history.
  api.delete('/standups/:id', async (req, res) => {
    const standup = await loadStandup(ctx, req, res);
    if (!standup) return;
    if (!allowed(principalOf(req), 'standups.delete')) return apiError(res, 403, 'forbidden', 'Only workspace admins can delete a standup.');
    if (standup.active) return apiError(res, 409, 'active', 'Archive the standup first; only archived standups can be deleted.');
    if (req.body?.confirm !== standup.name) {
      return apiError(res, 400, 'invalid', `Send { "confirm": "${standup.name}" } to delete this standup and all its history.`, 'confirm');
    }
    res.json({ deleted: await repo.deleteStandup(standup.id) });
  });

  api.post('/standups/:id/run-now', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'standups.configure' });
    if (!standup) return;
    res.json({ result: await ctx.scheduler.runNow(standup) });
  });

  // Manual reminder to everyone still expected today. Deliberately does not
  // touch remindedAt, so the scheduled reminder still fires as configured.
  api.post('/standups/:id/nudge', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'standups.configure' });
    if (!standup) return;
    const result = await nudgeToday(repo, ctx.adapter, standup, ctx.now());
    if (!result.ok) return apiError(res, result.status, result.code, result.message);
    res.json({ nudged: result.nudged });
  });

  api.get('/standups/:id/runs', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'reports.view' });
    if (!standup) return;
    res.json({ runs: await runsView(repo, standup, clampInt(req.query.limit, 14, 1, 90)) });
  });

  api.get('/standups/:id/runs/today', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'standups.view' });
    if (!standup) return;
    res.json(await todayView(repo, standup, ctx.now()));
  });

  api.get('/standups/:id/runs/:date', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'answers.view' });
    if (!standup) return;
    const date = String(req.params.date);
    if (!DATE_RE.test(date)) {
      apiError(res, 400, 'invalid', 'Date must be YYYY-MM-DD.', 'date');
      return;
    }
    const run = await runView(repo, standup, date, { moodComments: allowed(principalOf(req), 'moods.comments', standup.id) });
    if (!run) {
      apiError(res, 404, 'not_found', 'No run on that date.');
      return;
    }
    res.json(run);
  });

  api.get('/standups/:id/insights', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'reports.view' });
    if (!standup) return;
    res.json({ weeks: await weeklySeries(repo, standup, ctx.now(), clampInt(req.query.weeks, 8, 1, 26)) });
  });

  api.get('/standups/:id/export.csv', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'export' });
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

  // Roster candidates for managers, who cannot list arbitrary spaces.
  api.get('/standups/:id/members', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'people.manage' });
    if (!standup) return;
    try {
      res.json({ members: await ctx.adapter.listSpaceMembers(standup.spaceName) });
    } catch (err) {
      apiError(res, 502, 'chat_unavailable', `Google Chat did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Derived from SECRET_KEY, so it only changes when that does; managers need it to check signatures.
  api.get('/standups/:id/webhook/secret', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'standups.configure' });
    if (!standup) return;
    if (!ctx.webhookSecret) {
      apiError(res, 503, 'unavailable', 'Webhook signing is not available on this server.');
      return;
    }
    res.json({ secret: ctx.webhookSecret(standup.id) });
  });

  api.post('/standups/:id/participants', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'people.manage' });
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
    const standup = await loadStandup(ctx, req, res, { need: 'people.manage' });
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

  api.post('/standups/:id/roster/sync', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'people.manage' });
    if (!standup) return;
    if (!ctx.roster) return apiError(res, 503, 'unavailable', 'Group rosters are not available on this server.');
    if (!standup.rosterGroup) return apiError(res, 409, 'no_roster_group', 'This standup’s people are added by hand; set a roster group first.');
    const result = await ctx.roster.sync(standup);
    if (!result.ok) return apiError(res, 502, 'roster_unavailable', result.message);
    const fresh = (await repo.getStandupById(standup.id))!;
    res.json({ added: result.added, removed: result.removed, skipped: result.skipped, syncedAt: fresh.rosterSyncedAt });
  });

  api.delete('/standups/:id/participants/:userName', async (req, res) => {
    const standup = await loadStandup(ctx, req, res, { need: 'people.manage' });
    if (!standup) return;
    // On a group roster, taking someone off must survive the next sync.
    const userName = String(req.params.userName);
    const removed = standup.rosterGroup ? await repo.excludeParticipant(standup.id, userName) : await repo.removeParticipant(standup.id, userName);
    if (!removed) {
      apiError(res, 404, 'not_found', 'Not a participant.');
      return;
    }
    await ctx.service?.leaveOpenRuns(standup, userName);
    res.status(204).end();
  });
}
