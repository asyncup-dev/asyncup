import { describe, expect, it } from 'vitest';
import type { RunSummary } from '../src/core/types.js';
import { ANSWERS, makeStack, seedStandup } from './helpers.js';

// 2026-06-10 is a Wednesday. Defaults: prompt 09:30, deadline 11:30, reminder 60m.

describe('Scheduler', () => {
  it('does nothing before prompt time', async () => {
    const { repo, adapter, scheduler, clock } = makeStack();
    const standup = seedStandup(repo);
    clock.set('2026-06-10T09:00');
    await scheduler.tick();
    expect(repo.getRun(standup.id, '2026-06-10')).toBeNull();
    expect(adapter.dms).toHaveLength(0);
  });

  it('opens the run, posts the thread parent and prompts everyone at prompt time', async () => {
    const { repo, adapter, scheduler, clock } = makeStack();
    const standup = seedStandup(repo);
    clock.set('2026-06-10T09:30');
    await scheduler.tick();

    const run = repo.getRun(standup.id, '2026-06-10');
    expect(run).not.toBeNull();
    expect(run!.threadKey).toBe(`standup-${standup.id}-2026-06-10`);
    expect(adapter.posts.filter((p) => p.kind === 'parent')).toHaveLength(1);
    expect(adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName).sort()).toEqual([
      'users/alice',
      'users/bob',
      'users/carol',
    ]);
  });

  it('is idempotent: repeated ticks never re-prompt or re-open', async () => {
    const { repo, adapter, scheduler, clock } = makeStack();
    seedStandup(repo);
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    clock.set('2026-06-10T09:31');
    await scheduler.tick();
    await scheduler.tick();
    expect(adapter.dms.filter((d) => d.kind === 'prompt')).toHaveLength(3);
    expect(adapter.posts.filter((p) => p.kind === 'parent')).toHaveLength(1);
  });

  it('reminds only non-submitters, once', async () => {
    const { repo, adapter, scheduler, service, clock } = makeStack();
    const standup = seedStandup(repo);
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const run = repo.getRun(standup.id, '2026-06-10')!;

    clock.set('2026-06-10T10:00');
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);

    clock.set('2026-06-10T10:30'); // deadline 11:30 - 60m
    await scheduler.tick();
    const reminded = adapter.dms.filter((d) => d.kind === 'reminder').map((d) => d.userName).sort();
    expect(reminded).toEqual(['users/bob', 'users/carol']);

    clock.set('2026-06-10T10:35');
    await scheduler.tick();
    expect(adapter.dms.filter((d) => d.kind === 'reminder')).toHaveLength(2);
  });

  it('closes at the deadline and posts a summary with count and missing names', async () => {
    const { repo, adapter, scheduler, service, clock } = makeStack();
    const standup = seedStandup(repo);
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const run = repo.getRun(standup.id, '2026-06-10')!;

    clock.set('2026-06-10T10:00');
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    await service.submit(run.id, 'users/carol', 'Carol', ANSWERS);

    clock.set('2026-06-10T11:30');
    await scheduler.tick();

    expect(repo.getRunById(run.id)!.status).toBe('closed');
    const summaries = adapter.posts.filter((p) => p.kind === 'summary');
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!.payload as RunSummary;
    expect(summary.mandatoryTotal).toBe(2);
    expect(summary.mandatorySubmitted).toBe(1);
    expect(summary.missingMandatory).toEqual(['Bob']);
    expect(summary.optionalSubmitted).toBe(1);

    // late submission still posts, flagged late, but no second summary
    clock.set('2026-06-10T12:00');
    const late = await service.submit(run.id, 'users/bob', 'Bob', ANSWERS);
    expect(late).toEqual({ ok: true, late: true });
    await scheduler.tick();
    expect(adapter.posts.filter((p) => p.kind === 'summary')).toHaveLength(1);
  });

  it('skips days the standup is not configured for', async () => {
    const { repo, adapter, scheduler, clock } = makeStack();
    const standup = seedStandup(repo);
    clock.set('2026-06-13T09:30'); // Saturday
    await scheduler.tick();
    expect(repo.getRun(standup.id, '2026-06-13')).toBeNull();
    expect(adapter.dms).toHaveLength(0);
  });

  it('does not open a run when there are no participants', async () => {
    const { repo, adapter, scheduler, clock } = makeStack();
    const standup = repo.createStandup({
      tenantId: 'default',
      spaceName: 'spaces/empty',
      name: 'Empty',
      timezone: 'Asia/Kolkata',
    });
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    expect(repo.getRun(standup.id, '2026-06-10')).toBeNull();
    expect(adapter.posts).toHaveLength(0);
  });

  it('prompts each participant at prompt time in their own timezone', async () => {
    const { repo, adapter, scheduler, clock } = makeStack();
    const standup = seedStandup(repo, { deadlineTime: '18:00' });
    repo.setParticipantTimezone(standup.id, 'users/bob', 'Europe/London');

    // 09:30 IST: run opens, Alice and Carol prompted; Bob's London morning hasn't reached 09:30 yet
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    let prompted = adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName).sort();
    expect(prompted).toEqual(['users/alice', 'users/carol']);

    // 09:29 London → still not Bob's time
    clock.set('2026-06-10T09:29', 'Europe/London');
    await scheduler.tick();
    expect(adapter.dms.filter((d) => d.kind === 'prompt')).toHaveLength(2);

    // 09:30 London → Bob gets his prompt
    clock.set('2026-06-10T09:30', 'Europe/London');
    await scheduler.tick();
    prompted = adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName).sort();
    expect(prompted).toEqual(['users/alice', 'users/bob', 'users/carol']);
  });

  it('closes runs left open from previous days (e.g. after downtime)', async () => {
    const { repo, adapter, scheduler, clock } = makeStack();
    const standup = seedStandup(repo);
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    expect(repo.getRun(standup.id, '2026-06-10')!.status).toBe('open');

    // process was down past the deadline; next tick happens the following day
    clock.set('2026-06-11T08:00');
    await scheduler.tick();
    expect(repo.getRun(standup.id, '2026-06-10')!.status).toBe('closed');
    expect(adapter.posts.filter((p) => p.kind === 'summary')).toHaveLength(1);
  });
});
