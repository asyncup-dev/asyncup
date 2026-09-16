import type { Request, Response, Router } from 'express';
import { memberStandups, setMemberTimezone, setMemberVacation } from '../core/member.js';
import { runProgress } from '../core/progress.js';
import { apiError, clampInt, principalOf, type ApiContext } from './shared.js';

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
    const userName = principalOf(req).user?.userName ?? null;
    if (!userName) {
      res.json({ linked: false, standups: [] });
      return;
    }
    const mine = await memberStandups(repo, userName, ctx.now());
    const standups = [];
    for (const m of mine) {
      // How far the team has got today, so the console can say "7 of 9 have posted".
      const run = m.today ? await repo.getRun(m.standup.id, ctx.now().setZone(m.standup.timezone).toISODate()!) : null;
      const progress = run ? runProgress(await repo.listRunParticipants(run.id), await repo.listSubmissions(run.id)) : null;
      standups.push({
        id: m.standup.id,
        name: m.standup.name,
        schedule: {
          promptTime: m.standup.promptTime,
          deadlineTime: m.standup.deadlineTime,
          timezone: m.standup.timezone,
          days: m.standup.days.split(','),
        },
        today: m.today,
        progress: progress ? { submitted: progress.submitted, expected: progress.expected } : null,
        mandatory: m.mandatory,
        onVacation: m.onVacation,
      });
    }
    const dmSpace = await repo.getDmSpace(userName);
    res.json({
      linked: true,
      timezone: await repo.getUserTimezone(userName),
      // Answers stay in Chat: the console deep-links to the bot's DM once one exists.
      chat: { dmUrl: dmSpace ? `https://chat.google.com/dm/${dmSpace.replace(/^spaces\//, '')}` : null },
      standups,
    });
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
        answers: submission.answers,
      })),
    });
  });

  api.patch('/me', async (req, res) => {
    const userName = linkedUser(req, res);
    if (!userName) return;
    const body = req.body ?? {};
    if (body.onVacation !== undefined && typeof body.onVacation !== 'boolean') {
      apiError(res, 400, 'invalid', 'Must be true or false.', 'onVacation');
      return;
    }
    if (body.timezone !== undefined) {
      const result = await setMemberTimezone(repo, userName, body.timezone === null ? '' : String(body.timezone));
      if (!result.ok) {
        apiError(res, 400, 'invalid', result.message, 'timezone');
        return;
      }
    }
    if (body.onVacation !== undefined) await setMemberVacation(repo, userName, body.onVacation);
    const mine = await memberStandups(repo, userName, ctx.now());
    res.json({
      timezone: await repo.getUserTimezone(userName),
      onVacation: mine.length > 0 && mine.every((m) => m.onVacation),
    });
  });
}
