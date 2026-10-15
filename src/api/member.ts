import type { Request, Response, Router } from 'express';
import { skipToday, updateMe } from './actions.js';
import { apiError, clampInt, findVisibleStandup, principalOf, type ApiContext } from './shared.js';
import { myStandupsView } from './views.js';

/** The signed-in person's own view: their standups, answers and settings. */
export function registerMemberRoutes(api: Router, ctx: ApiContext): void {
  const { repo } = ctx;

  /** Chat identity of the caller, or a 409 explaining why there is none yet. */
  const linkedUser = (req: Request<any>, res: Response): string | null => {
    const userName = principalOf(req).user?.userName ?? null;
    if (!userName) {
      apiError(
        res,
        409,
        'not_linked',
        'This account is not linked to a Google Chat identity yet — it links the first time you use the AsyncUp bot in Chat, or when an admin enables Directory lookups.',
      );
    }
    return userName;
  };

  api.get('/me/standups', async (req, res) => {
    res.json(await myStandupsView(repo, principalOf(req).user?.userName ?? null, ctx.now()));
  });

  api.get('/me/submissions', async (req, res) => {
    const userName = principalOf(req).user?.userName ?? null;
    const rows = userName ? await repo.listRecentSubmissionsForUser(userName, clampInt(req.query.limit, 10, 1, 50)) : [];
    res.json({
      submissions: rows.map(({ submission, runDate, standupName }) => ({
        date: runDate,
        standupName,
        submittedAt: submission.submittedAt,
        editedAt: submission.editedAt,
        late: submission.late,
        mood: submission.mood,
        moodComment: submission.moodComment,
        answers: submission.answers,
      })),
    });
  });

  // Skip today's run for one standup — the API twin of the DM `skip` command.
  api.post('/me/skip', async (req, res) => {
    const userName = linkedUser(req, res);
    if (!userName) return;
    if (!ctx.service) {
      apiError(res, 503, 'unavailable', 'Skipping is not available on this server.');
      return;
    }
    const found = await findVisibleStandup(repo, principalOf(req), Number(req.body?.standupId));
    if (!found) {
      apiError(res, 404, 'not_found', 'No such standup.');
      return;
    }
    const result = await skipToday(repo, ctx.service, found.standup, userName, ctx.now(), req.body?.reason);
    if (!result.ok) return apiError(res, result.status, result.code, result.message, result.field);
    res.json({ result: result.result, date: result.date });
  });

  api.patch('/me', async (req, res) => {
    const userName = linkedUser(req, res);
    if (!userName) return;
    const body = req.body ?? {};
    if (body.onVacation !== undefined && typeof body.onVacation !== 'boolean') {
      apiError(res, 400, 'invalid', 'Must be true or false.', 'onVacation');
      return;
    }
    const result = await updateMe(repo, userName, { timezone: body.timezone === undefined ? undefined : body.timezone === null ? null : String(body.timezone), onVacation: body.onVacation }, ctx.now());
    if (!result.ok) return apiError(res, result.status, result.code, result.message, result.field);
    res.json({ timezone: result.timezone, onVacation: result.onVacation });
  });
}
