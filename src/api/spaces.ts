import type { Request, Response, Router } from 'express';
import { TEMPLATES } from '../core/templates.js';
import { apiError, principalOf, type ApiContext } from './shared.js';

/** Create-standup helpers: the template gallery, the space picker and roster suggestions. */
export function registerSpaceRoutes(api: Router, ctx: ApiContext): void {
  api.get('/templates', (_req, res) => {
    res.json({ templates: TEMPLATES });
  });

  const adminOnly = (req: Request<any>, res: Response): boolean => {
    if (principalOf(req).kind === 'admin') return true;
    apiError(res, 403, 'forbidden', 'Admins only.');
    return false;
  };

  // The Chat API answers with the service account; a failure there is the
  // operator's problem to fix in settings, so it surfaces as 502 with the reason.
  const chatFailed = (res: Response, err: unknown) =>
    apiError(res, 502, 'chat_unavailable', `Google Chat did not answer: ${err instanceof Error ? err.message : String(err)}`);

  api.get('/spaces', async (req, res) => {
    if (!adminOnly(req, res)) return;
    let spaces;
    try {
      spaces = await ctx.adapter.listSpaces();
    } catch (err) {
      chatFailed(res, err);
      return;
    }
    const standups = await ctx.repo.listStandupsForTenant(principalOf(req).tenantId);
    res.json({
      spaces: spaces.map((s) => ({
        ...s,
        standups: standups.filter((x) => x.spaceName === s.name).map((x) => ({ id: x.id, name: x.name })),
      })),
    });
  });

  // `:name` is the space resource name URL-encoded (spaces%2FAAAA).
  api.get('/spaces/:name/members', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const name = String(req.params.name);
    if (!name.startsWith('spaces/')) {
      apiError(res, 400, 'invalid', 'Expected a Chat space resource name (spaces/…).', 'name');
      return;
    }
    try {
      res.json({ members: await ctx.adapter.listSpaceMembers(name) });
    } catch (err) {
      chatFailed(res, err);
    }
  });
}
