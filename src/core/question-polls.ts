import { DateTime } from 'luxon';
import type { ChatAdapter } from './adapter.js';
import type { Mention } from './commands.js';
import type { Standup } from './types.js';
import type { WebhookNotifier } from './webhooks.js';
import type { Repo } from '../db/repo.js';

export const QUESTION_TYPES = ['short', 'long', 'dropdown', 'single', 'multiple'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const RESULTS_VISIBILITY = ['everyone', 'managers'] as const;
export type ResultsVisibility = (typeof RESULTS_VISIBILITY)[number];
/** Minutes before the close a reminder may go: 15 minutes, 1 hour or 1 day. */
export const REMINDER_MINUTES = [15, 60, 1440] as const;

export const POLL_LIMITS = { title: 100, intro: 500, questions: 10, question: 200, options: 20, option: 80, short: 200, long: 1000 } as const;

export interface PollQuestion {
  text: string;
  type: QuestionType;
  required: boolean;
  /** Choice questions only; empty for text questions. */
  options: string[];
}

/** What the builder sends. `closesAt` is a local date and time in the standup's timezone. */
export interface PollDraft {
  title: string;
  intro: string | null;
  questions: PollQuestion[];
  closesAt: string;
  remindMinutes: number | null;
  anonymous: boolean;
  results: ResultsVisibility;
}

/** One answer per question: text, the option indexes picked, or null when left empty. */
export type PollAnswer = string | number[] | null;

export interface QuestionPoll {
  id: number;
  standupId: number;
  title: string;
  intro: string | null;
  questions: PollQuestion[];
  anonymous: boolean;
  results: ResultsVisibility;
  closesAt: string;
  remindAt: string | null;
  remindedAt: string | null;
  createdBy: string;
  createdDisplay: string;
  createdAt: string;
  closedAt: string | null;
  spaceMessage: string | null;
  /** The answered count the space card last showed, and when. */
  spaceCount: number;
  spaceDrawnAt: string | null;
}

export interface PollPerson {
  pollId: number;
  userName: string;
  displayName: string;
  cardMessages: string[];
  remindedAt: string | null;
  answers: PollAnswer[] | null;
  answeredAt: string | null;
}

/** What cards and dialogs show about a poll. */
export interface PollView {
  id: number;
  standupId: number;
  standupName: string;
  title: string;
  intro: string | null;
  from: string;
  questions: PollQuestion[];
  /** "Wed 10 Jun, 17:00 Asia/Kolkata" */
  closesLabel: string;
  /** "17:00 Asia/Kolkata" */
  closesTime: string;
  anonymous: boolean;
  results: ResultsVisibility;
  zone: string;
}

export type PollCardState = { kind: 'open' } | { kind: 'reminder' } | { kind: 'answered'; at: string } | { kind: 'closed'; answeredAt: string | null };

export interface PollCounts {
  asked: number;
  answered: number;
}

export interface OptionResult {
  text: string;
  count: number;
  /** Null on an anonymous poll, or when names are withheld from the caller. */
  names: string[] | null;
}

export interface QuestionResult {
  text: string;
  type: QuestionType;
  answered: number;
  options: OptionResult[];
  /** Text answers, in the order given; `name` is null when withheld. */
  answers: { name: string | null; text: string }[];
}

export type DraftCheck = { ok: true; value: Omit<QuestionPoll, 'id' | 'standupId' | 'createdBy' | 'createdDisplay' | 'createdAt' | 'closedAt' | 'spaceMessage' | 'spaceCount' | 'spaceDrawnAt' | 'remindedAt'> } | { ok: false; field: string; message: string };
export type CreateResult = { ok: true; poll: QuestionPoll } | { ok: false; field: string; message: string };
export type FormResult = { ok: true; view: PollView; answers: PollAnswer[] | null } | { ok: false; message: string };
export type AnswerResult = { ok: true; message: string } | { ok: false; message: string; missing?: string };

const isChoice = (type: QuestionType) => type === 'dropdown' || type === 'single' || type === 'multiple';

/**
 * One-off polls with several questions, sent by DM to a standup's roster,
 * that close at a set time. The scheduler's tick reminds, redraws the space
 * card and closes from the database, so a restart never repeats or skips one.
 */
export class QuestionPolls {
  constructor(
    private repo: Repo,
    private adapter: ChatAdapter,
    private now: () => DateTime,
    private log: (msg: string) => void,
    private webhooks: WebhookNotifier | null = null,
  ) {}

  /** Checks a draft against the limits and turns it into what is stored. */
  check(standup: Standup, draft: PollDraft): DraftCheck {
    const title = typeof draft.title === 'string' ? draft.title.trim() : '';
    if (!title) return { ok: false, field: 'title', message: 'Give the poll a title.' };
    if (title.length > POLL_LIMITS.title) return { ok: false, field: 'title', message: `Keep the title to ${POLL_LIMITS.title} characters.` };
    const intro = typeof draft.intro === 'string' && draft.intro.trim() ? draft.intro.trim() : null;
    if (intro && intro.length > POLL_LIMITS.intro) return { ok: false, field: 'intro', message: `Keep the intro to ${POLL_LIMITS.intro} characters.` };
    const raw = Array.isArray(draft.questions) ? draft.questions : [];
    if (raw.length < 1 || raw.length > POLL_LIMITS.questions) return { ok: false, field: 'questions', message: `Add 1 to ${POLL_LIMITS.questions} questions.` };
    const questions: PollQuestion[] = [];
    for (const [i, q] of raw.entries()) {
      const field = `questions.${i}`;
      const n = i + 1;
      const text = typeof q?.text === 'string' ? q.text.trim() : '';
      if (!QUESTION_TYPES.includes(q?.type)) return { ok: false, field, message: `Question ${n} has an unknown type.` };
      if (!text || text.length > POLL_LIMITS.question) return { ok: false, field, message: `Question ${n} needs its text, up to ${POLL_LIMITS.question} characters.` };
      const options = isChoice(q.type) ? (Array.isArray(q.options) ? q.options : []).map((o) => (typeof o === 'string' ? o.trim() : '')).filter(Boolean) : [];
      if (isChoice(q.type)) {
        if (options.length < 2 || options.length > POLL_LIMITS.options) return { ok: false, field, message: `Question ${n} needs 2 to ${POLL_LIMITS.options} options.` };
        if (options.some((o) => o.length > POLL_LIMITS.option)) return { ok: false, field, message: `Keep each option to ${POLL_LIMITS.option} characters.` };
        const seen = new Set<string>();
        for (const o of options) {
          if (seen.has(o.toLowerCase())) return { ok: false, field, message: `Question ${n} has the option “${o}” twice.` };
          seen.add(o.toLowerCase());
        }
      }
      questions.push({ text, type: q.type, required: q.required === true, options });
    }
    const closes = typeof draft.closesAt === 'string' ? DateTime.fromISO(draft.closesAt, { zone: standup.timezone }) : DateTime.invalid('missing');
    const now = this.now();
    if (!closes.isValid || closes < now.plus({ minutes: 15 }) || closes > now.plus({ days: 14 })) {
      return { ok: false, field: 'closesAt', message: 'Close it between 15 minutes and 14 days from now.' };
    }
    let remindAt: string | null = null;
    if (draft.remindMinutes !== null && draft.remindMinutes !== undefined) {
      if (!(REMINDER_MINUTES as readonly number[]).includes(draft.remindMinutes)) {
        return { ok: false, field: 'remindMinutes', message: 'Remind 15 minutes, 1 hour or 1 day before, or not at all.' };
      }
      const at = closes.minus({ minutes: draft.remindMinutes });
      if (at <= now) return { ok: false, field: 'remindMinutes', message: 'That reminder would be in the past. Choose a shorter one, or none.' };
      remindAt = at.toUTC().toISO()!;
    }
    if (!RESULTS_VISIBILITY.includes(draft.results)) return { ok: false, field: 'results', message: 'Results go to everyone after it closes, or to managers only.' };
    return { ok: true, value: { title, intro, questions, anonymous: draft.anonymous === true, results: draft.results, closesAt: closes.toUTC().toISO()!, remindAt } };
  }

  /** Sends a poll to everyone active on the roster except people on vacation. */
  async create(standup: Standup, draft: PollDraft, creator: Mention): Promise<CreateResult> {
    const checked = this.check(standup, draft);
    if (!checked.ok) return checked;
    const people = (await this.repo.listParticipants(standup.id)).filter((p) => !p.onVacation);
    if (people.length === 0) return { ok: false, field: 'standupId', message: `Nobody on ${standup.name} can be asked: everyone is on vacation or the roster is empty.` };
    const at = this.now().toUTC().toISO()!;
    const poll = await this.repo.createQuestionPoll({ ...checked.value, standupId: standup.id, createdBy: creator.userName, createdDisplay: creator.displayName, createdAt: at }, people);
    const view = this.viewOf(poll, standup);
    for (const p of people) {
      try {
        const name = await this.adapter.sendPollCard(p.userName, view, { kind: 'open' });
        if (name) await this.repo.addQuestionPollCard(poll.id, p.userName, name);
      } catch (err) {
        this.log(`poll ${poll.id} to ${p.userName} failed: ${err}`);
      }
    }
    try {
      const name = await this.adapter.postPollSummary(standup, view, { asked: people.length, answered: 0 }, false);
      if (name) await this.repo.setQuestionPollSpace(poll.id, name, 0, at);
    } catch (err) {
      this.log(`poll ${poll.id} summary failed: ${err}`);
    }
    return { ok: true, poll: (await this.repo.getQuestionPoll(poll.id))! };
  }

  async list(standupId: number): Promise<QuestionPoll[]> {
    return this.repo.listQuestionPolls(standupId);
  }

  async get(id: number): Promise<{ poll: QuestionPoll; standup: Standup } | null> {
    const poll = await this.repo.getQuestionPoll(id);
    if (!poll) return null;
    const standup = await this.repo.getStandupById(poll.standupId);
    return standup ? { poll, standup } : null;
  }

  async people(id: number): Promise<PollPerson[]> {
    return this.repo.listQuestionPollPeople(id);
  }

  /** What the Chat form needs to open: the poll, and the person's earlier answers. */
  async form(id: number, userName: string): Promise<FormResult> {
    const found = await this.get(id);
    if (!found) return { ok: false, message: 'This poll no longer exists.' };
    const { poll, standup } = found;
    const view = this.viewOf(poll, standup);
    if (this.isClosed(poll)) return { ok: false, message: `This poll closed at ${view.closesTime}.` };
    const person = (await this.repo.listQuestionPollPeople(id)).find((p) => p.userName === userName);
    if (!person) return { ok: false, message: 'This poll wasn’t sent to you.' };
    return { ok: true, view, answers: person.answers };
  }

  /** Records someone's answers, or says what is wrong; `missing` names a required question left empty. */
  async answer(id: number, user: Mention, raw: PollAnswer[]): Promise<AnswerResult> {
    const opened = await this.form(id, user.userName);
    if (!opened.ok) return opened;
    const { view } = opened;
    const answers: PollAnswer[] = [];
    for (const [i, q] of view.questions.entries()) {
      const a = raw[i];
      if (isChoice(q.type)) {
        const picked = Array.isArray(a) ? [...new Set(a)].sort((x, y) => x - y) : [];
        if (picked.some((n) => !Number.isInteger(n) || n < 0 || n >= q.options.length)) return { ok: false, message: 'That option no longer exists.' };
        if (q.type !== 'multiple' && picked.length > 1) return { ok: false, message: `Pick one answer for “${q.text}”.` };
        if (q.required && picked.length === 0) return { ok: false, message: `Answer “${q.text}”`, missing: q.text };
        answers.push(q.type === 'multiple' ? picked : (picked.length ? picked : null));
      } else {
        const text = typeof a === 'string' ? a.trim() : '';
        const max = q.type === 'long' ? POLL_LIMITS.long : POLL_LIMITS.short;
        if (text.length > max) return { ok: false, message: `Keep “${q.text}” to ${max.toLocaleString('en-GB')} characters.` };
        if (q.required && !text) return { ok: false, message: `Answer “${q.text}”`, missing: q.text };
        answers.push(text || null);
      }
    }
    const at = this.now().toUTC().toISO()!;
    await this.repo.saveQuestionPollAnswers(id, user.userName, answers, at);
    const person = (await this.repo.listQuestionPollPeople(id)).find((p) => p.userName === user.userName)!;
    await this.redraw(person.cardMessages, view, { kind: 'answered', at: person.answeredAt! });
    return { ok: true, message: `✅ Answered. You can change your answers until ${view.closesTime}.` };
  }

  /** Each tick: close polls whose time has come, send due reminders, and refresh space counts. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const poll of await this.repo.listOpenQuestionPolls()) {
      try {
        if (now >= DateTime.fromISO(poll.closesAt)) await this.close(poll.id, null);
        else {
          if (poll.remindAt && !poll.remindedAt && now >= DateTime.fromISO(poll.remindAt)) await this.remind(poll);
          await this.refreshCount(poll);
        }
      } catch (err) {
        this.log(`poll ${poll.id}: ${err}`);
      }
    }
  }

  /** Closes a poll now; the manager's right to was checked by the caller. */
  async close(id: number, _by: Mention | null): Promise<'closed' | 'already_closed' | 'not_found'> {
    const found = await this.get(id);
    if (!found) return 'not_found';
    const { standup } = found;
    if (!(await this.repo.closeQuestionPoll(id, this.now().toUTC().toISO()!))) return 'already_closed';
    const poll = (await this.repo.getQuestionPoll(id))!;
    const view = this.viewOf(poll, standup);
    const people = await this.repo.listQuestionPollPeople(id);
    for (const p of people) await this.redraw(p.cardMessages, view, { kind: 'closed', answeredAt: p.answeredAt });
    const counts = countsOf(people);
    if (poll.spaceMessage) {
      try {
        await this.adapter.updatePollSummary(poll.spaceMessage, view, counts, true);
      } catch (err) {
        this.log(`poll ${id} summary redraw failed: ${err}`);
      }
    }
    const results = resultsOf(poll, people, !poll.anonymous);
    try {
      await this.adapter.postText(standup.spaceName, resultsText(poll, standup, counts, results), `qpoll-${poll.id}`);
    } catch (err) {
      this.log(`poll ${id} results post failed: ${err}`);
    }
    await this.webhooks?.pollClosed(standup, {
      id: poll.id,
      title: poll.title,
      anonymous: poll.anonymous,
      asked: counts.asked,
      answered: counts.answered,
      questions: results.map((r) => ({ text: r.text, type: r.type, answered: r.answered, options: r.options })),
    });
    return 'closed';
  }

  /** Results for someone allowed to see them; names only when the poll is named and `names` is true. */
  async results(id: number, names: boolean): Promise<{ counts: PollCounts; notAnswered: string[] | null; questions: QuestionResult[] } | null> {
    const poll = await this.repo.getQuestionPoll(id);
    if (!poll) return null;
    const people = await this.repo.listQuestionPollPeople(id);
    const withNames = names && !poll.anonymous;
    return {
      counts: countsOf(people),
      notAnswered: withNames ? people.filter((p) => !p.answeredAt).map((p) => p.displayName) : null,
      questions: resultsOf(poll, people, withNames),
    };
  }

  /** One row per answer; the person is left out of an anonymous poll. */
  async csv(id: number): Promise<string | null> {
    const poll = await this.repo.getQuestionPoll(id);
    if (!poll) return null;
    const people = await this.repo.listQuestionPollPeople(id);
    const header = poll.anonymous ? ['question', 'answer', 'answered_at'] : ['person', 'question', 'answer', 'answered_at'];
    const rows = [header];
    for (const p of people) {
      if (!p.answers) continue;
      for (const [i, q] of poll.questions.entries()) {
        const a = p.answers[i];
        if (a === null || a === undefined || (Array.isArray(a) && a.length === 0)) continue;
        const text = Array.isArray(a) ? a.map((n) => q.options[n]).join('; ') : a;
        rows.push(poll.anonymous ? [q.text, text, p.answeredAt ?? ''] : [p.displayName, q.text, text, p.answeredAt ?? '']);
      }
    }
    return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
  }

  isClosed(poll: QuestionPoll): boolean {
    return poll.closedAt !== null || this.now() >= DateTime.fromISO(poll.closesAt);
  }

  viewOf(poll: QuestionPoll, standup: Standup): PollView {
    const closes = DateTime.fromISO(poll.closesAt).setZone(standup.timezone).setLocale('en-GB');
    return {
      id: poll.id,
      standupId: standup.id,
      standupName: standup.name,
      title: poll.title,
      intro: poll.intro,
      from: poll.createdDisplay,
      questions: poll.questions,
      closesLabel: `${closes.toFormat('ccc d LLL, HH:mm')} ${standup.timezone}`,
      closesTime: `${closes.toFormat('HH:mm')} ${standup.timezone}`,
      anonymous: poll.anonymous,
      results: poll.results,
      zone: standup.timezone,
    };
  }

  private async remind(poll: QuestionPoll): Promise<void> {
    if (!(await this.repo.markQuestionPollReminded(poll.id, this.now().toUTC().toISO()!))) return;
    const standup = (await this.repo.getStandupById(poll.standupId))!;
    const view = this.viewOf(poll, standup);
    for (const p of await this.repo.listQuestionPollPeople(poll.id)) {
      if (p.answeredAt || p.remindedAt) continue;
      try {
        const name = await this.adapter.sendPollCard(p.userName, view, { kind: 'reminder' });
        await this.repo.markQuestionPollPersonReminded(poll.id, p.userName, this.now().toUTC().toISO()!, name);
      } catch (err) {
        this.log(`poll ${poll.id} reminder to ${p.userName} failed: ${err}`);
      }
    }
  }

  /** Space allows one write a second for every app, so the count redraws at most once a minute. */
  private async refreshCount(poll: QuestionPoll): Promise<void> {
    if (!poll.spaceMessage) return;
    if (poll.spaceDrawnAt && this.now() < DateTime.fromISO(poll.spaceDrawnAt).plus({ minutes: 1 })) return;
    const counts = countsOf(await this.repo.listQuestionPollPeople(poll.id));
    if (counts.answered === poll.spaceCount) return;
    const standup = (await this.repo.getStandupById(poll.standupId))!;
    await this.adapter.updatePollSummary(poll.spaceMessage, this.viewOf(poll, standup), counts, false);
    await this.repo.setQuestionPollSpace(poll.id, poll.spaceMessage, counts.answered, this.now().toUTC().toISO()!);
  }

  private async redraw(messageNames: string[], view: PollView, state: PollCardState): Promise<void> {
    if (messageNames.length === 0) return;
    try {
      await this.adapter.updatePollCards(messageNames, view, state);
    } catch (err) {
      this.log(`poll ${view.id} card redraw failed: ${err}`);
    }
  }
}

function countsOf(people: PollPerson[]): PollCounts {
  return { asked: people.length, answered: people.filter((p) => p.answeredAt).length };
}

function resultsOf(poll: QuestionPoll, people: PollPerson[], names: boolean): QuestionResult[] {
  const answered = people.filter((p) => p.answers);
  return poll.questions.map((q, i) => {
    const given = answered.filter((p) => {
      const a = p.answers![i];
      return a !== null && a !== undefined && !(Array.isArray(a) && a.length === 0);
    });
    return {
      text: q.text,
      type: q.type,
      answered: given.length,
      options: q.options.map((text, n) => {
        const who = given.filter((p) => Array.isArray(p.answers![i]) && (p.answers![i] as number[]).includes(n));
        return { text, count: who.length, names: names ? who.map((p) => p.displayName) : null };
      }),
      answers: isChoice(q.type) ? [] : given.map((p) => ({ name: names ? p.displayName : null, text: p.answers![i] as string })),
    };
  });
}

/** The post in the space's thread when a poll closes. */
export function resultsText(poll: QuestionPoll, standup: Standup, counts: PollCounts, results: QuestionResult[]): string {
  const head = `📊 *${poll.title}*`;
  if (poll.results === 'managers') return `${head} closed: ${counts.answered} of ${counts.asked} answered. Results are with the standup’s managers.`;
  const choice = results.filter((r) => isChoice(r.type)).map((r) => `*${r.text}*\n${r.options.map((o) => `${o.text}: *${o.count}*${o.names?.length ? ` — ${o.names.join(', ')}` : ''}`).join('\n')}`);
  const text = results.filter((r) => !isChoice(r.type)).map((r) => `*${r.text}* ${r.answered} answer${r.answered === 1 ? '' : 's'}`);
  const parts = [`${head}: ${counts.answered} of ${counts.asked} answered`, ...choice];
  if (text.length) parts.push(`${text.join('\n')}\n\nText answers are in the web app, under ${standup.name} › Polls.`);
  return parts.join('\n\n');
}

function csvCell(value: string): string {
  // A leading =, +, - or @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
