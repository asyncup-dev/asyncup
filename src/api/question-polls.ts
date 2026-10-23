import type { Request, Response, Router } from 'express';
import type { PollDraft, QuestionPoll, QuestionPolls } from '../core/question-polls.js';
import type { Standup } from '../core/types.js';
import type { Principal } from './principal.js';
import { allowed, apiError, loadStandup, principalOf, type ApiContext } from './shared.js';

/** A poll as lists show it. */
export async function pollSummaryView(polls: QuestionPolls, poll: QuestionPoll, standup: Standup) {
  const people = await polls.people(poll.id);
  return {
    id: poll.id,
    standupId: poll.standupId,
    title: poll.title,
    from: poll.createdDisplay,
    createdAt: poll.createdAt,
    closesAt: poll.closesAt,
    closesLabel: polls.viewOf(poll, standup).closesLabel,
    closedAt: poll.closedAt,
    open: !polls.isClosed(poll),
    anonymous: poll.anonymous,
    results: poll.results,
    asked: people.length,
    answered: people.filter((x) => x.answeredAt).length,
  };
}

/**
 * Results go to the standup's managers (members can read answers too, so
 * that permission would leak results early), and, once an everyone-sees poll
 * has closed, to the people it asked. An anonymous poll never names anyone.
 */
export async function pollDetailView(polls: QuestionPolls, poll: QuestionPoll, standup: Standup, p: Principal) {
  const asked = (await polls.people(poll.id)).some((x) => x.userName === p.user?.userName);
  const canSee = allowed(p, 'standups.configure', standup.id) || (asked && poll.results === 'everyone' && polls.isClosed(poll));
  return {
    ...(await pollSummaryView(polls, poll, standup)),
    intro: poll.intro,
    questions: poll.questions,
    remindAt: poll.remindAt,
    outcome: canSee ? await outcomeOf(polls, poll) : null,
  };
}

async function outcomeOf(polls: QuestionPolls, poll: QuestionPoll) {
  const r = (await polls.results(poll.id, true))!;
  return { notAnswered: r.notAnswered, questions: r.questions };
}

/** Finds a poll the caller may see, or answers the request. */
export async function findPoll(ctx: ApiContext, p: Principal, id: number): Promise<{ poll: QuestionPoll; standup: Standup } | null> {
  const found = await ctx.service?.questionPolls.get(id);
  if (!found || found.standup.tenantId !== p.tenantId || !allowed(p, 'standups.view', found.standup.id)) return null;
  return found;
}

/** Polls with questions: managers send and close them; results follow `pollDetailView`. */
export function registerQuestionPollRoutes(api: Router, ctx: ApiContext): void {
  const service = (res: Response) => {
    if (!ctx.service) apiError(res, 503, 'unavailable', 'Polls are not available on this install.');
    return ctx.service?.questionPolls ?? null;
  };
  const poll = async (req: Request<any>, res: Response) => {
    const found = await findPoll(ctx, principalOf(req), Number(req.params.id) || 0);
    if (!found) apiError(res, 404, 'not_found', 'No such poll.');
    return found;
  };

  api.get('/standups/:id/question-polls', async (req, res) => {
    const polls = service(res);
    if (!polls) return;
    const standup = await loadStandup(ctx, req, res, { need: 'standups.view' });
    if (!standup) return;
    const list = await polls.list(standup.id);
    res.json({ polls: await Promise.all(list.map((x) => pollSummaryView(polls, x, standup))) });
  });

  api.post('/standups/:id/question-polls', async (req, res) => {
    const polls = service(res);
    if (!polls) return;
    const standup = await loadStandup(ctx, req, res, { need: 'standups.configure' });
    if (!standup) return;
    const p = principalOf(req);
    const body = req.body ?? {};
    const draft: PollDraft = {
      title: body.title,
      intro: body.intro ?? null,
      questions: Array.isArray(body.questions) ? body.questions.map((q: any) => ({ text: q?.text, type: q?.type, required: q?.required === true, options: Array.isArray(q?.options) ? q.options : [] })) : [],
      closesAt: body.closesAt,
      remindMinutes: body.remindMinutes ?? null,
      anonymous: body.anonymous === true,
      results: body.results ?? 'everyone',
    };
    const result = await polls.create(standup, draft, { userName: p.user?.userName ?? 'operator', displayName: p.user?.name ?? 'Operator' });
    if (!result.ok) {
      apiError(res, 400, 'invalid', result.message, result.field);
      return;
    }
    res.status(201).json(await pollDetailView(polls, result.poll, standup, p));
  });

  api.get('/question-polls/:id', async (req, res) => {
    const polls = service(res);
    if (!polls) return;
    const found = await poll(req, res);
    if (!found) return;
    res.json(await pollDetailView(polls, found.poll, found.standup, principalOf(req)));
  });

  api.post('/question-polls/:id/close', async (req, res) => {
    const polls = service(res);
    if (!polls) return;
    const found = await poll(req, res);
    if (!found) return;
    const p = principalOf(req);
    if (!allowed(p, 'standups.configure', found.standup.id)) {
      apiError(res, 403, 'forbidden', `Only the managers of ${found.standup.name} can close it.`);
      return;
    }
    if ((await polls.close(found.poll.id, null)) !== 'closed') {
      apiError(res, 409, 'closed', 'This poll has already closed.');
      return;
    }
    res.json(await pollDetailView(polls, (await polls.get(found.poll.id))!.poll, found.standup, p));
  });

  api.get('/question-polls/:id/export.csv', async (req, res) => {
    const polls = service(res);
    if (!polls) return;
    const found = await poll(req, res);
    if (!found) return;
    if (!allowed(principalOf(req), 'standups.configure', found.standup.id)) {
      apiError(res, 403, 'forbidden', `Only the managers of ${found.standup.name} can export its polls.`);
      return;
    }
    res
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="poll-${found.poll.id}.csv"`)
      .send(await polls.csv(found.poll.id));
  });
}
