import { DateTime } from 'luxon';
import { FakeAdapter } from '../src/adapters/fake/adapter.js';
import { AiSummarizer } from '../src/ai/summarizer.js';
import { BlockerService } from '../src/core/blocker-service.js';
import { CommandHandler } from '../src/core/commands.js';
import type { OooChecker } from '../src/core/ooo.js';
import { Scheduler } from '../src/core/scheduler.js';
import { SettingsService } from '../src/core/settings.js';
import { StandupService } from '../src/core/standup-service.js';
import { DEFAULT_QUESTIONS, type SubmissionInput } from '../src/core/types.js';
import { Repo } from '../src/db/repo.js';

export const TZ = 'Asia/Kolkata';
export const TENANT = 'default';

let schemaCounter = 0;

export async function makeStack(opts: { summarizer?: AiSummarizer | null; ooo?: OooChecker | null } = {}) {
  let repo: Repo;
  if (process.env.TEST_DATABASE_URL) {
    const schema = `t_${process.pid}_${Date.now()}_${schemaCounter++}`;
    repo = await Repo.postgres(process.env.TEST_DATABASE_URL, schema);
  } else {
    repo = await Repo.sqlite(':memory:');
  }
  const adapter = new FakeAdapter();

  let current = DateTime.fromISO('2026-06-10T00:00:00', { zone: TZ });
  const clock = {
    now: () => current,
    /** e.g. set('2026-06-10T09:30') — interpreted in the standup TZ by default */
    set: (iso: string, zone: string = TZ) => {
      current = DateTime.fromISO(iso, { zone });
    },
  };

  const settings = new SettingsService(repo, 'test-secret-key', clock.now);
  await settings.update({ defaultTimezone: TZ });
  const service = new StandupService(repo, adapter, clock.now);
  const blockers = new BlockerService(repo, adapter, clock.now);
  const scheduler = new Scheduler(repo, adapter, service, clock.now, () => {}, {
    summarizer: async () => opts.summarizer ?? null,
    ooo: async () => opts.ooo ?? null,
  });
  const commands = new CommandHandler(repo, settings, clock.now, blockers);

  return { repo, adapter, service, blockers, settings, scheduler, commands, clock };
}

export async function seedStandup(repo: Repo, opts: { deadlineTime?: string; spaceName?: string } = {}) {
  const standup = await repo.createStandup({
    tenantId: TENANT,
    spaceName: opts.spaceName ?? 'spaces/team',
    name: 'Daily Standup',
    timezone: TZ,
  });
  // defaults: prompt 09:30, deadline 11:30, reminder 60m, mon-fri
  if (opts.deadlineTime) await repo.updateStandup(standup.id, { deadlineTime: opts.deadlineTime });
  await repo.upsertParticipant({ standupId: standup.id, userName: 'users/alice', displayName: 'Alice' });
  await repo.upsertParticipant({ standupId: standup.id, userName: 'users/bob', displayName: 'Bob' });
  await repo.upsertParticipant({
    standupId: standup.id,
    userName: 'users/carol',
    displayName: 'Carol',
    mandatory: false,
  });
  return (await repo.getStandupById(standup.id))!;
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
