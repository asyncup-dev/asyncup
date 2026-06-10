import { describe, expect, it } from 'vitest';
import type { Submission } from '../src/core/types.js';
import { ANSWERS, makeStack, seedStandup } from './helpers.js';

describe('StandupService', () => {
  it('records a submission and posts it to the thread', async () => {
    const { repo, adapter, service } = makeStack();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');

    const result = await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    expect(result).toEqual({ ok: true, late: false });

    const posts = adapter.posts.filter((p) => p.kind === 'submission');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.threadKey).toBe('key');
    expect((posts[0]!.payload as Submission).mood).toBe('good');
  });

  it('rejects duplicates, unknown runs and non-participants', async () => {
    const { repo, service } = makeStack();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');

    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    expect(await service.submit(run.id, 'users/alice', 'Alice', ANSWERS)).toEqual({
      ok: false,
      reason: 'already_submitted',
    });
    expect(await service.submit(999, 'users/alice', 'Alice', ANSWERS)).toEqual({
      ok: false,
      reason: 'run_not_found',
    });
    expect(await service.submit(run.id, 'users/mallory', 'Mallory', ANSWERS)).toEqual({
      ok: false,
      reason: 'not_a_participant',
    });
  });

  it('flags submissions to closed runs as late', async () => {
    const { repo, service } = makeStack();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');
    repo.closeRun(run.id);

    expect(await service.submit(run.id, 'users/alice', 'Alice', ANSWERS)).toEqual({
      ok: true,
      late: true,
    });
    expect(repo.getSubmission(run.id, 'users/alice')!.late).toBe(true);
  });

  it('builds summaries with mandatory/optional/late breakdown', async () => {
    const { repo, service } = makeStack();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');

    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    await service.submit(run.id, 'users/carol', 'Carol', ANSWERS); // optional
    repo.closeRun(run.id);
    await service.submit(run.id, 'users/bob', 'Bob', ANSWERS); // late

    const summary = service.buildSummary(run.id);
    expect(summary.mandatoryTotal).toBe(2);
    expect(summary.mandatorySubmitted).toBe(2);
    expect(summary.missingMandatory).toEqual([]);
    expect(summary.optionalSubmitted).toBe(1);
    expect(summary.lateCount).toBe(1);
  });
});
