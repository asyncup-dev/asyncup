import { describe, expect, it } from 'vitest';
import { AiSummarizer } from '../src/ai/summarizer.js';
import type { RunSummary } from '../src/core/types.js';
import { ANSWERS, makeStack, seedStandup } from './helpers.js';

// 2026-06-10 is a Wednesday. Defaults: prompt 09:30, deadline 11:30, reminder 60m.

describe('Scheduler', () => {
  it('does nothing before prompt time', async () => {
    const { repo, adapter, scheduler, clock } = await makeStack();
    const standup = await seedStandup(repo);
    clock.set('2026-06-10T09:00');
    await scheduler.tick();
    expect(await repo.getRun(standup.id, '2026-06-10')).toBeNull();
    expect(adapter.dms).toHaveLength(0);
  });

  it('opens the run, posts the thread parent and prompts everyone at prompt time', async () => {
    const { repo, adapter, scheduler, clock } = await makeStack();
    const standup = await seedStandup(repo);
    clock.set('2026-06-10T09:30');
    await scheduler.tick();

    const run = await repo.getRun(standup.id, '2026-06-10');
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
    const { adapter, scheduler, clock, repo } = await makeStack();
    await seedStandup(repo);
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    clock.set('2026-06-10T09:31');
    await scheduler.tick();
    await scheduler.tick();
    expect(adapter.dms.filter((d) => d.kind === 'prompt')).toHaveLength(3);
    expect(adapter.posts.filter((p) => p.kind === 'parent')).toHaveLength(1);
  });

  it('never prompts or reminds vacationing or skipped participants', async () => {
    const { repo, adapter, scheduler, service, clock } = await makeStack();
    const standup = await seedStandup(repo);
    await repo.setParticipantVacation(standup.id, 'users/carol', true);

    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    expect(adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName).sort()).toEqual([
      'users/alice',
      'users/bob',
    ]);

    await service.skipToday(run.id, 'users/bob');
    clock.set('2026-06-10T10:30');
    await scheduler.tick();
    expect(adapter.dms.filter((d) => d.kind === 'reminder').map((d) => d.userName)).toEqual([
      'users/alice',
    ]);
  });

  it('reminds only non-submitters, once', async () => {
    const { repo, adapter, scheduler, service, clock } = await makeStack();
    const standup = await seedStandup(repo);
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;

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

  it('closes at the deadline and posts a summary with count, missing and away names', async () => {
    const { repo, adapter, scheduler, service, clock } = await makeStack();
    const standup = await seedStandup(repo);
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;

    clock.set('2026-06-10T10:00');
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    await service.submit(run.id, 'users/carol', 'Carol', ANSWERS);

    clock.set('2026-06-10T11:30');
    await scheduler.tick();

    expect((await repo.getRunById(run.id))!.status).toBe('closed');
    const summaries = adapter.posts.filter((p) => p.kind === 'summary');
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!.payload as RunSummary;
    expect(summary.mandatoryTotal).toBe(2);
    expect(summary.mandatorySubmitted).toBe(1);
    expect(summary.missingMandatory).toEqual(['Bob']);
    expect(summary.optionalSubmitted).toBe(1);

    clock.set('2026-06-10T12:00');
    const late = await service.submit(run.id, 'users/bob', 'Bob', ANSWERS);
    expect(late).toEqual({ ok: true, late: true, edited: false });
    await scheduler.tick();
    expect(adapter.posts.filter((p) => p.kind === 'summary')).toHaveLength(1);
  });

  it('skips days the standup is not configured for', async () => {
    const { repo, adapter, scheduler, clock } = await makeStack();
    const standup = await seedStandup(repo);
    clock.set('2026-06-13T09:30'); // Saturday
    await scheduler.tick();
    expect(await repo.getRun(standup.id, '2026-06-13')).toBeNull();
    expect(adapter.dms).toHaveLength(0);
  });

  it('does not open a run when everyone is on vacation', async () => {
    const { repo, adapter, scheduler, clock } = await makeStack();
    const standup = await seedStandup(repo);
    for (const p of await repo.listParticipants(standup.id)) {
      await repo.setParticipantVacation(standup.id, p.userName, true);
    }
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    expect(await repo.getRun(standup.id, '2026-06-10')).toBeNull();
    expect(adapter.posts).toHaveLength(0);
  });

  it('prompts each participant at prompt time in their own timezone', async () => {
    const { repo, adapter, scheduler, clock } = await makeStack();
    const standup = await seedStandup(repo, { deadlineTime: '18:00' });
    await repo.setParticipantTimezone(standup.id, 'users/bob', 'Europe/London');

    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    let prompted = adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName).sort();
    expect(prompted).toEqual(['users/alice', 'users/carol']);

    clock.set('2026-06-10T09:29', 'Europe/London');
    await scheduler.tick();
    expect(adapter.dms.filter((d) => d.kind === 'prompt')).toHaveLength(2);

    clock.set('2026-06-10T09:30', 'Europe/London');
    await scheduler.tick();
    prompted = adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName).sort();
    expect(prompted).toEqual(['users/alice', 'users/bob', 'users/carol']);
  });

  it('closes runs left open from previous days (e.g. after downtime)', async () => {
    const { repo, adapter, scheduler, clock } = await makeStack();
    const standup = await seedStandup(repo);
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    expect((await repo.getRun(standup.id, '2026-06-10'))!.status).toBe('open');

    clock.set('2026-06-11T08:00');
    await scheduler.tick();
    expect((await repo.getRun(standup.id, '2026-06-10'))!.status).toBe('closed');
    expect(adapter.posts.filter((p) => p.kind === 'summary')).toHaveLength(1);
  });

  it('posts the weekly digest after the last configured day of the week', async () => {
    const { repo, adapter, scheduler, service, clock } = await makeStack();
    const standup = await seedStandup(repo);
    await repo.updateStandup(standup.id, { digestEnabled: true });

    // Wednesday run: closes without a digest
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const wed = (await repo.getRun(standup.id, '2026-06-10'))!;
    await service.submit(wed.id, 'users/alice', 'Alice', ANSWERS);
    clock.set('2026-06-10T11:30');
    await scheduler.tick();
    expect(adapter.posts.filter((p) => p.kind === 'text')).toHaveLength(0);

    // Friday run: digest follows the close
    clock.set('2026-06-12T09:30');
    await scheduler.tick();
    const fri = (await repo.getRun(standup.id, '2026-06-12'))!;
    await service.submit(fri.id, 'users/alice', 'Alice', ANSWERS);
    clock.set('2026-06-12T11:30');
    await scheduler.tick();

    const digests = adapter.posts.filter((p) => p.kind === 'text');
    expect(digests).toHaveLength(1);
    expect(digests[0]!.text).toContain('weekly digest');
    expect(digests[0]!.text).toContain('Participation');
    expect(digests[0]!.threadKey).toContain('digest-');
  });

  it('posts an AI summary after close when enabled and configured', async () => {
    const fakeLlm = async (_system: string, prompt: string) => `TLDR for: ${prompt.slice(0, 20)}…`;
    const { repo, adapter, scheduler, service, clock } = await makeStack({
      summarizer: new AiSummarizer(fakeLlm),
    });
    const standup = await seedStandup(repo);
    await repo.updateStandup(standup.id, { aiEnabled: true });

    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);

    clock.set('2026-06-10T11:30');
    await scheduler.tick();

    const texts = adapter.posts.filter((p) => p.kind === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toContain('🤖 *AI summary*');
    expect(texts[0]!.threadKey).toBe(run.threadKey);
  });

  it('never posts an AI summary when no one submitted', async () => {
    const fakeLlm = async () => 'should not be called';
    const { repo, adapter, scheduler, clock } = await makeStack({ summarizer: new AiSummarizer(fakeLlm) });
    const standup = await seedStandup(repo);
    await repo.updateStandup(standup.id, { aiEnabled: true });

    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    clock.set('2026-06-10T11:30');
    await scheduler.tick();
    expect(adapter.posts.filter((p) => p.kind === 'text')).toHaveLength(0);
  });
});
