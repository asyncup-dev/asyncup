import type { Request, Response, Router } from 'express';
import type { Mention } from '../core/commands.js';
import type { Blocker } from '../core/types.js';
import { LIMITS } from '../core/validation.js';
import { apiError, canManage, principalOf, visibleStandups, type ApiContext } from './shared.js';

const STATUSES = new Set(['open', 'acknowledged', 'resolved', 'all']);

export function registerBlockerRoutes(api: Router, ctx: ApiContext): void {
  const { repo } = ctx;

  const view = async (b: Blocker, standupName: string) => {
    const tags = await repo.listBlockerTags(b.id);
    const updates = await repo.listBlockerUpdates(b.id);
    return {
      id: b.id,
      standup: { id: b.standupId, name: standupName },
      owner: { userName: b.userName, displayName: b.displayName },
      text: b.text,
      openedDate: b.openedDate,
      resolvedDate: b.resolvedDate,
      resolvedBy: b.resolvedBy,
      escalatedAt: b.escalatedAt,
      status: b.resolvedDate ? 'resolved' : tags.some((t) => t.acknowledgedAt) ? 'acknowledged' : 'open',
      tags: tags.map((t) => ({ userName: t.userName, displayName: t.displayName, acknowledgedAt: t.acknowledgedAt })),
      updates: updates.map((u) => ({ userName: u.userName, displayName: u.displayName, text: u.text, at: u.createdAt })),
    };
  };

  api.get('/blockers', async (req, res) => {
    const p = principalOf(req);
    const status = String(req.query.status ?? 'open');
    if (!STATUSES.has(status)) {
      apiError(res, 400, 'invalid', 'status must be open, acknowledged, resolved or all.', 'status');
      return;
    }
    const visible = await visibleStandups(repo, p);
    const requested = req.query.standupId === undefined ? null : Number(req.query.standupId);
    const standupIds = visible.map((s) => s.id).filter((id) => requested === null || id === requested);
    const names = new Map(visible.map((s) => [s.id, s.name]));
    const rows = await repo.listBlockers({
      tenantId: p.tenantId,
      status: status === 'acknowledged' ? 'open' : (status as 'open' | 'resolved' | 'all'),
      standupIds,
      ...(req.query.owner ? { userName: String(req.query.owner) } : {}),
    });
    const blockers = [];
    for (const b of rows) {
      const v = await view(b, names.get(b.standupId)!);
      if (status === 'acknowledged' && v.status !== 'acknowledged') continue;
      blockers.push(v);
    }
    res.json({ blockers });
  });

  /** Blocker actions need a person: the operator token has no identity to act as. */
  const actor = async (req: Request<any>, res: Response): Promise<{ blocker: Blocker; me: Mention } | null> => {
    const p = principalOf(req);
    if (!p.user?.userName) {
      apiError(res, 403, 'needs_user', 'Blocker actions need a signed-in person, not the operator token.');
      return null;
    }
    const blocker = await repo.getBlockerById(Number(req.params.id));
    const standup = blocker ? await repo.getStandupById(blocker.standupId) : null;
    const member =
      !!standup &&
      standup.tenantId === p.tenantId &&
      (canManage(p, standup.id) || (await repo.listParticipants(standup.id)).some((x) => x.userName === p.user!.userName));
    if (!blocker || !member) {
      apiError(res, 404, 'not_found', 'No such blocker.');
      return null;
    }
    return { blocker, me: { userName: p.user.userName, displayName: p.user.name } };
  };

  api.post('/blockers/:id/acknowledge', async (req, res) => {
    const a = await actor(req, res);
    if (!a) return;
    const result = await ctx.blockers.acknowledge(a.blocker.id, a.me);
    if (result === 'not_found') return apiError(res, 404, 'not_found', 'No such open blocker.');
    if (result === 'not_tagged') return apiError(res, 403, 'not_tagged', 'Only people tagged on a blocker can acknowledge it.');
    if (result === 'already_acked') return apiError(res, 409, 'already_acknowledged', 'You already acknowledged this blocker.');
    res.json({ result });
  });

  api.post('/blockers/:id/update', async (req, res) => {
    const a = await actor(req, res);
    if (!a) return;
    const text = String(req.body?.text ?? '').trim();
    if (!text || text.length > LIMITS.textMax) {
      apiError(res, 400, 'invalid', `Update text is required (≤${LIMITS.textMax} characters).`, 'text');
      return;
    }
    const result = await ctx.blockers.addUpdate(a.blocker.id, a.me, text);
    if (result === 'resolved') return apiError(res, 409, 'resolved', 'This blocker is already resolved.');
    res.json({ result });
  });

  api.post('/blockers/:id/resolve', async (req, res) => {
    const a = await actor(req, res);
    if (!a) return;
    const result = await ctx.blockers.resolve(a.blocker.id, a.me);
    if (result === 'already_resolved') return apiError(res, 409, 'resolved', 'This blocker is already resolved.');
    if (result === 'not_allowed') return apiError(res, 403, 'not_allowed', 'Only the owner, tagged people and standup admins can resolve a blocker.');
    res.json({ result });
  });
}
