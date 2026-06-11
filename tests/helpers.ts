import { DateTime } from 'luxon';
import { FakeAdapter } from '../src/adapters/fake/adapter.js';
import { AiSummarizer } from '../src/ai/summarizer.js';
import { CommandHandler } from '../src/core/commands.js';
import { Scheduler } from '../src/core/scheduler.js';
import { StandupService } from '../src/core/standup-service.js';
import { DEFAULT_QUESTIONS, type SubmissionInput } from '../src/core/types.js';
import { Repo } from '../src/db/repo.js';

export const TZ = 'Asia/Kolkata';
export const TENANT = 'default';

export function makeStack(opts: { summarizer?: AiSummarizer | null } = {}) {
  const repo = new Repo(':memory:');
  const adapter = new FakeAdapter();

  let current = DateTime.fromISO('2026-06-10T00:00:00', { zone: TZ });
  const clock = {
    now: () => current,
    /** e.g. set('2026-06-10T09:30') — interpreted in the standup TZ by default */
    set: (iso: string, zone: string = TZ) => {
      current = DateTime.fromISO(iso, { zone });
    },
  };

  const service = new StandupService(repo, adapter, clock.now);
  const scheduler = new Scheduler(repo, adapter, service, clock.now, () => {}, opts.summarizer ?? null);
  const commands = new CommandHandler(repo, TZ, clock.now);

  return { repo, adapter, service, scheduler, commands, clock };
}

export function seedStandup(repo: Repo, opts: { deadlineTime?: string; spaceName?: string } = {}) {
  const standup = repo.createStandup({
    tenantId: TENANT,
    spaceName: opts.spaceName ?? 'spaces/team',
    name: 'Daily Standup',
    timezone: TZ,
  });
  // defaults: prompt 09:30, deadline 11:30, reminder 60m, mon-fri
  if (opts.deadlineTime) repo.updateStandup(standup.id, { deadlineTime: opts.deadlineTime });
  repo.upsertParticipant({ standupId: standup.id, userName: 'users/alice', displayName: 'Alice' });
  repo.upsertParticipant({ standupId: standup.id, userName: 'users/bob', displayName: 'Bob' });
  repo.upsertParticipant({
    standupId: standup.id,
    userName: 'users/carol',
    displayName: 'Carol',
    mandatory: false,
  });
  return repo.getStandupById(standup.id)!;
}

export const ANSWERS: SubmissionInput = {
  answers: [
    { question: DEFAULT_QUESTIONS[0], answer: 'Shipped the auth refactor' },
    { question: DEFAULT_QUESTIONS[1], answer: 'Start billing webhooks' },
    { question: DEFAULT_QUESTIONS[2], answer: 'none' },
  ],
  mood: 'good',
};

export function withBlocker(text: string): SubmissionInput {
  return {
    answers: [
      { question: DEFAULT_QUESTIONS[0], answer: 'Worked on infra' },
      { question: DEFAULT_QUESTIONS[1], answer: 'More infra' },
      { question: DEFAULT_QUESTIONS[2], answer: text },
    ],
    mood: 'meh',
  };
}
