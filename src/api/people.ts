import type { Router } from 'express';
import { apiError, principalOf, type ApiContext } from './shared.js';
import { peopleView } from './views.js';

/** The Team directory: everyone on a roster the caller may see, with their standups and roles. */
export function registerPeopleRoutes(api: Router, ctx: ApiContext): void {
  const { repo } = ctx;

  api.get('/people', async (req, res) => {
    const p = principalOf(req);
    if (p.kind === 'member') {
      apiError(res, 403, 'forbidden', 'Only admins and managers can list the team.');
      return;
    }
    res.json({ people: await peopleView(repo, p) });
  });
}
