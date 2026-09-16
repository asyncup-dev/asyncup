import { describe, expect, it, spyOn } from 'bun:test';
import { DateTime } from 'luxon';
import { FakeAdapter } from '../src/adapters/fake/adapter.js';
import { BlockerService } from '../src/core/blocker-service.js';
import { CommandHandler } from '../src/core/commands.js';
import { PollService } from '../src/core/poll-service.js';
import { Scheduler } from '../src/core/scheduler.js';
import { SettingsService } from '../src/core/settings.js';
import { StandupService } from '../src/core/standup-service.js';
import type { RunSummary } from '../src/core/types.js';
import { looksLikeEmail } from '../src/core/validation.js';
import { WebhookNotifier } from '../src/core/webhooks.js';
import { Repo } from '../src/db/repo.js';
import { ANSWERS, makeStack, seedStandup, TENANT, TZ, withBlocker } from './helpers.js';

const ALICE = { userName: 'users/alice', displayName: 'Alice' };
const BOB = { userName: 'users/bob', displayName: 'Bob' };

function secondsFromNow(iso: string): number {
  return Math.abs(DateTime.fromISO(iso).diff(DateTime.utc(), 'seconds').seconds);
}

const summary: RunSummary = {
  standupName: 'Daily Standup',
  date: '2026-06-10',
  mandatoryTotal: 2,
  mandatorySubmitted: 1,
  missingMandatory: ['Bob'],
  away: [],
  optionalSubmitted: 0,
  lateCount: 0,
  openBlockers: 0,
  teamMood: null,
};

describe('looksLikeEmail', () => {
  it('accepts a plain address and rejects malformed shapes without backtracking', () => {
    expect(looksLikeEmail('asha@example.com')).toBe(true);
    expect(looksLikeEmail('first.last+tag@sub.example.co')).toBe(true);
    expect(looksLikeEmail('@example.com')).toBe(false);
    expect(looksLikeEmail('asha@@example.com')).toBe(false);
    expect(looksLikeEmail('asha@example')).toBe(false);
    expect(looksLikeEmail('asha@.com')).toBe(false);
    expect(looksLikeEmail('asha@example.')).toBe(false);
    expect(looksLikeEmail('asha @example.com')).toBe(false);
  });
});

describe('Wall-clock defaults', () => {
  it('services stamp records with the current time when no clock is injected', async () => {
    const { repo, adapter } = await makeStack();
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, DateTime.utc().setZone(TZ).toISODate()!, 'k');

    const service = new StandupService(repo, adapter);
    expect(await service.submit(run.id, ALICE.userName, ALICE.displayName, withBlocker('Waiting on keys'))).toEqual({
      ok: true,
      late: false,
      edited: false,
    });
    const submission = (await repo.getSubmission(run.id, ALICE.userName))!;
    expect(secondsFromNow(submission.submittedAt)).toBeLessThan(60);

    const blocker = (await repo.listOpenBlockers(standup.id))[0]!;
    const blockers = new BlockerService(repo, adapter);
    expect(await blockers.tag(standup, blocker.id, [BOB], ALICE)).toContain('Tagged Bob');
    const tag = (await repo.listBlockerTags(blocker.id))[0]!;
    expect(secondsFromNow(tag.taggedAt)).toBeLessThan(60);

    const polls = new PollService(repo, adapter);
    const poll = await polls.create(standup, 'Lunch?', ['Yes', 'No'], ALICE);
    expect(await polls.close(standup, poll.id, ALICE)).toBe('closed');
    const closed = (await repo.getPollById(poll.id))!;
    expect(secondsFromNow(closed.closedAt!)).toBeLessThan(60);
  });

  it('settings and commands use the current time when no clock is injected', async () => {
    const repo = await Repo.sqlite(':memory:');
    const settings = new SettingsService(repo, 'test-secret-key');
    await settings.update({ defaultTimezone: TZ, tickToken: 'abc' });
    expect((await settings.get()).tickToken).toBe('abc');

    const commands = new CommandHandler(repo, settings);
    const sender = { userName: 'users/admin', displayName: 'Admin' };
    const ctx = (text: string) => ({ tenantId: TENANT, spaceName: 'spaces/team', text, mentions: [], sender });
    expect(await commands.handle(ctx('setup'))).toContain('created');
    const today = DateTime.utc().setZone(TZ).toISODate()!;
    expect(await commands.handle(ctx('status'))).toContain(`No run yet today (${today})`);
  });
});

describe('Scheduler.start', () => {
  it('ticks on the interval, logs a failed tick and keeps going', async () => {
    const { repo, adapter, service } = await makeStack();
    const scheduler = new Scheduler(repo, adapter, service);
    const listActive = spyOn(repo, 'listActiveStandups').mockRejectedValue(new Error('db down'));
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const timer = scheduler.start(5);
      try {
        await new Promise((resolve) => setTimeout(resolve, 60));
      } finally {
        clearInterval(timer);
      }
      expect(listActive.mock.calls.length).toBeGreaterThan(1);
      expect(log).toHaveBeenCalledWith('[scheduler] tick failed: Error: db down');
    } finally {
      listActive.mockRestore();
      log.mockRestore();
    }
  });
});

describe('WebhookNotifier defaults', () => {
  it('logs to the console and sends unsigned when no secret provider is configured', async () => {
    const { repo } = await makeStack();
    const standup = await seedStandup(repo);
    await repo.updateStandup(standup.id, { webhookUrl: 'https://hooks.example/asyncup' });
    const configured = (await repo.getStandupById(standup.id))!;

    const calls: { headers: Record<string, string> }[] = [];
    const fetchFn = (async (_url: any, init: any) => {
      calls.push({ headers: init.headers });
      return new Response('', { status: 503 });
    }) as typeof fetch;
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await new WebhookNotifier(undefined, fetchFn).wrapUp(configured, '2026-06-10', summary);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.headers['x-asyncup-signature']).toBeUndefined();
      expect(log).toHaveBeenCalledWith('[webhook] wrap_up → https://hooks.example/asyncup answered 503');

      const failing = (async (_url: any, _init: any) => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;
      await new WebhookNotifier(undefined, failing).wrapUp(configured, '2026-06-10', summary);
      expect(log).toHaveBeenCalledWith('[webhook] wrap_up → https://hooks.example/asyncup failed: Error: ECONNREFUSED');
    } finally {
      log.mockRestore();
    }
  });
});

describe('Scheduler with participant timezones', () => {
  it('opens the run when prompt time arrives in the earliest zone on the roster', async () => {
    const { repo, adapter, scheduler, clock } = await makeStack();
    const standup = await seedStandup(repo);
    await repo.setTimezoneForUser('users/alice', 'Asia/Tokyo');
    await repo.setTimezoneForUser('users/carol', 'America/New_York');

    clock.set('2026-06-10T05:00');
    await scheduler.tick();
    expect(await repo.getRun(standup.id, '2026-06-10')).toBeNull();

    clock.set('2026-06-10T06:00'); // 09:30 in Tokyo
    await scheduler.tick();
    expect(await repo.getRun(standup.id, '2026-06-10')).not.toBeNull();
    expect(adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName)).toEqual(['users/alice']);

    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    expect(adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName).sort()).toEqual([
      'users/alice',
      'users/bob',
    ]);
  });
});

describe('Scheduler.runNow on an open run', () => {
  it('prompts only those not yet prompted and skips people who already submitted', async () => {
    const { repo, adapter, scheduler, service, clock } = await makeStack();
    const standup = await seedStandup(repo);
    await repo.setTimezoneForUser('users/bob', 'America/New_York');

    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    const prompted = () => adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName).sort();
    expect(prompted()).toEqual(['users/alice', 'users/carol']);

    await service.submit(run.id, 'users/bob', 'Bob', ANSWERS);
    expect(await scheduler.runNow(standup)).toBe('already_open');
    expect(prompted()).toEqual(['users/alice', 'users/carol']);
  });

  it('prompts a participant whose local prompt time has not come yet', async () => {
    const { repo, adapter, scheduler, clock } = await makeStack();
    const standup = await seedStandup(repo);
    await repo.setTimezoneForUser('users/bob', 'America/New_York');

    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    expect(await scheduler.runNow(standup)).toBe('already_open');
    expect(adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName).sort()).toEqual([
      'users/alice',
      'users/bob',
      'users/carol',
    ]);
  });
});
