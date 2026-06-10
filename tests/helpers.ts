import { DateTime } from 'luxon';
import { FakeAdapter } from '../src/adapters/fake/adapter.js';
import { CommandHandler } from '../src/core/commands.js';
import { Scheduler } from '../src/core/scheduler.js';
import { StandupService } from '../src/core/standup-service.js';
import { Repo } from '../src/db/repo.js';

export const TZ = 'Asia/Kolkata';
export const TENANT = 'default';

export function makeStack() {
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
  const scheduler = new Scheduler(repo, adapter, service, clock.now, () => {});
  const commands = new CommandHandler(repo, TZ, clock.now);

  return { repo, adapter, service, scheduler, commands, clock };
}

export function seedStandup(repo: Repo, opts: { deadlineTime?: string } = {}) {
  const standup = repo.createStandup({
    tenantId: TENANT,
    spaceName: 'spaces/team',
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

export const ANSWERS = {
  yesterday: 'Shipped the auth refactor',
  today: 'Start billing webhooks',
  blockers: 'none',
  mood: 'good',
} as const;
