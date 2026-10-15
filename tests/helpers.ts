import { GroupAccessError, type GroupDirectory, type GroupListing } from '../src/core/groups.js';
import { RosterSync } from '../src/core/roster-sync.js';
import { LeavePresence, type LeaveWriter, type OooEvent } from '../src/core/leave-presence.js';
import { DateTime } from 'luxon';
import { ScheduleService } from '../src/core/schedule.js';
import { FakeAdapter } from '../src/adapters/fake/adapter.js';
import { BlockerService } from '../src/core/blocker-service.js';
import { CommandHandler } from '../src/core/commands.js';
import { PollService } from '../src/core/poll-service.js';
import type { UserDirectory } from '../src/core/directory.js';
import type { OooChecker } from '../src/core/ooo.js';
import { Scheduler } from '../src/core/scheduler.js';
import { SettingsService } from '../src/core/settings.js';
import { StandupService } from '../src/core/standup-service.js';
import { deriveWebhookSecret } from '../src/core/crypto.js';
import { WebhookNotifier } from '../src/core/webhooks.js';
import { DEFAULT_QUESTIONS, type SubmissionInput } from '../src/core/types.js';
import { Repo } from '../src/db/repo.js';

export const TZ = 'Asia/Kolkata';
export const TENANT = 'default';

let schemaCounter = 0;
const openRepos = new Set<Repo>();

/** Called from tests/setup.ts after every test so Postgres connections don't pile up. */
export async function closeOpenRepos(): Promise<void> {
  const repos = [...openRepos];
  openRepos.clear();
  await Promise.all(repos.map((r) => r.close().catch(() => {})));
}

export async function makeStack(
  opts: {
    ooo?: OooChecker | null;
    directory?: UserDirectory | null;
    webhookFetch?: typeof fetch;
  } = {},
) {
  let repo: Repo;
  if (process.env.TEST_DATABASE_URL) {
    const schema = `t_${process.pid}_${Date.now()}_${schemaCounter++}`;
    repo = await Repo.postgres(process.env.TEST_DATABASE_URL, schema);
  } else {
    repo = await Repo.sqlite(':memory:');
  }
  openRepos.add(repo);
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
  const webhooks = opts.webhookFetch
    ? new WebhookNotifier(() => {}, opts.webhookFetch, 5_000, (id) => deriveWebhookSecret('test-secret-key', id))
    : null;
  const service = new StandupService(repo, adapter, clock.now, webhooks);
  const scheduleRef: { current: ScheduleService | undefined } = { current: undefined };
  const blockers = new BlockerService(repo, adapter, clock.now);
  const groups = new FakeGroups();
  const roster = new RosterSync(repo, async () => groups, clock.now, () => {}, service, adapter);
  const leaveWriter = new FakeLeaveWriter();
  const leave = new LeavePresence(repo, settings, async () => leaveWriter, clock.now);
  const scheduler = new Scheduler(
    repo,
    adapter,
    service,
    clock.now,
    () => {},
    {
      ooo: async () => opts.ooo ?? null,
      directory: async () => opts.directory ?? null,
      roster,
      leave,
      get schedule() {
        return scheduleRef.current;
      },
    },
    webhooks,
  );
  const polls = new PollService(repo, adapter, clock.now);
  const schedule = new ScheduleService(repo, adapter, clock.now, webhooks, () => {}, async () => (await settings.get()).leaveInChat);
  scheduleRef.current = schedule;
  const commands = new CommandHandler(repo, settings, clock.now, blockers, adapter, polls, schedule, service);
  commands.attachRunner(scheduler);

  return { repo, adapter, service, blockers, polls, settings, scheduler, commands, clock, schedule, groups, roster, leave, leaveWriter };
}

/** Chat statuses and calendars as Google would keep them, per email; `fail` makes the next calls throw. */
export class FakeLeaveWriter implements LeaveWriter {
  statuses = new Map<string, { text: string; emoji: string; expireTime: string | null }>();
  events = new Map<string, OooEvent & { email: string }>();
  calls: string[] = [];
  fail: { status?: Error; calendar?: Error } = {};
  private next = 0;

  async setStatus(email: string, status: { text: string; emoji: string; expireTime: string | null }): Promise<void> {
    this.calls.push(`status ${email} ${status.text}`);
    if (this.fail.status) throw this.fail.status;
    this.statuses.set(email, status);
  }
  async clearStatus(email: string, text: string): Promise<void> {
    this.calls.push(`clear ${email} ${text}`);
    if (this.fail.status) throw this.fail.status;
    if (this.statuses.get(email)?.text === text) this.statuses.delete(email);
  }
  async createOutOfOffice(email: string, event: OooEvent): Promise<string> {
    this.calls.push(`create ${email}`);
    if (this.fail.calendar) throw this.fail.calendar;
    const id = `ev${++this.next}`;
    this.events.set(id, { ...event, email });
    return id;
  }
  async updateOutOfOffice(email: string, id: string, event: OooEvent): Promise<void> {
    this.calls.push(`update ${email} ${id}`);
    if (this.fail.calendar) throw this.fail.calendar;
    this.events.set(id, { ...event, email });
  }
  async deleteOutOfOffice(email: string, id: string): Promise<void> {
    this.calls.push(`delete ${email} ${id}`);
    if (this.fail.calendar) throw this.fail.calendar;
    this.events.delete(id);
  }
}

/** Google Groups as the tests want them: a listing per group email, or an error to throw. */
export class FakeGroups implements GroupDirectory {
  listings = new Map<string, GroupListing | Error>();
  calls: string[] = [];

  async listMembers(group: string): Promise<GroupListing> {
    this.calls.push(group);
    const listing = this.listings.get(group);
    if (!listing) throw new GroupAccessError(`There is no Google Group ${group}.`);
    if (listing instanceof Error) throw listing;
    return listing;
  }
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
