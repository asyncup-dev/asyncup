import type { Response, Router } from 'express';
import type { EditRequestView } from '../core/edit-requests.js';
import { canSomewhere } from '../core/permissions.js';
import { allowed, apiError, principalOf, type ApiContext } from './shared.js';

export function editRequestView(r: EditRequestView) {
  return {
    id: r.id,
    standupId: r.standup.id,
    standupName: r.standup.name,
    date: r.date,
    userName: r.person.userName,
    displayName: r.person.displayName,
    reason: r.reason,
    askedAt: r.askedAt,
    answeredAt: r.answeredAt,
    until: r.until,
  };
}

/** Requests to edit answers after the deadline: whoever configures a standup decides its requests. */
export function registerEditRequestRoutes(api: Router, ctx: ApiContext): void {
  const service = (res: Response) => {
    if (!ctx.service) apiError(res, 503, 'unavailable', 'Answers are not available on this install.');
    return ctx.service;
  };

  api.get('/edit-requests', async (req, res) => {
    const svc = service(res);
    if (!svc) return;
    const p = principalOf(req);
    if (!canSomewhere(p.access, 'standups.configure')) {
      apiError(res, 403, 'forbidden', 'Only admins and managers see requests.');
      return;
    }
    const mine = (await svc.edits.listPending()).filter((r) => r.standup.tenantId === p.tenantId && allowed(p, 'standups.configure', r.standup.id));
    res.json({ requests: mine.map(editRequestView) });
  });

  for (const decision of ['approve', 'decline'] as const) {
    api.post(`/edit-requests/:id/${decision}`, async (req, res) => {
      const svc = service(res);
      if (!svc) return;
      const p = principalOf(req);
      const request = await svc.edits.getView(Number(req.params.id) || 0);
      if (!request || request.standup.tenantId !== p.tenantId) {
        apiError(res, 404, 'not_found', 'No such request.');
        return;
      }
      if (!allowed(p, 'standups.configure', request.standup.id)) {
        apiError(res, 403, 'forbidden', `Only the managers of ${request.standup.name} decide this.`);
        return;
      }
      const note = req.body?.note ? String(req.body.note).trim().slice(0, 200) || null : null;
      const actor = { userName: p.user?.userName ?? 'operator', displayName: p.user?.name ?? 'Operator', admin: true };
      const result = await svc.edits.decide(request.id, decision === 'approve', actor, note);
      if (!result.ok) {
        apiError(res, 409, 'refused', result.message);
        return;
      }
      res.json({ ok: true, message: result.message });
    });
  }
}
