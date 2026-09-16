import type { Request, Response, Router } from 'express';
import type { Mention } from '../core/commands.js';
import type { Blocker } from '../core/types.js';
import { LIMITS } from '../core/validation.js';
import { apiError, principalOf, type ApiContext } from './shared.js';
import { BLOCKER_STATUSES, blockersView, visibleBlocker, type BlockerStatusFilter } from './views.js';

export function registerBlockerRoutes(api: Router, ctx: ApiContext): void {
  const { repo } = ctx;

  api.get('/blockers', async (req, res) => {
    const status = String(req.query.status ?? 'open') as BlockerStatusFilter;
    if (!BLOCKER_STATUSES.includes(status)) {
      apiError(res, 400, 'invalid', 'status must be open, acknowledged, resolved or all.', 'status');
      return;
    }
    const standupId = req.query.standupId === undefined ? null : Number(req.query.standupId);
    res.json({
      blockers: await blockersView(repo, principalOf(req), { status, standupId, ...(req.query.owner ? { owner: String(req.query.owner) } : {}) }),
    });
  });

  /** Blocker actions need a person: the operator token has no identity to act as. */
  const actor = async (req: Request<any>, res: Response): Promise<{ blocker: Blocker; me: Mention } | null> => {
    const p = principalOf(req);
    if (!p.user?.userName) {
      apiError(res, 403, 'needs_user', 'Blocker actions need a signed-in person, not the operator token.');
      return null;
    }
    const blocker = await visibleBlocker(repo, p, Number(req.params.id));
    if (!blocker) {
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
