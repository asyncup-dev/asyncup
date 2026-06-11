import { describe, expect, it } from 'vitest';
import type { Submission } from '../src/core/types.js';
import { ANSWERS, makeStack, seedStandup, withBlocker } from './helpers.js';

describe('StandupService', () => {
  it('records a submission, posts it, and stores the message name', async () => {
    const { repo, adapter, service } = makeStack();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');

    const result = await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    expect(result).toEqual({ ok: true, late: false, edited: false });

    const posts = adapter.posts.filter((p) => p.kind === 'submission');
    expect(posts).toHaveLength(1);
    expect((posts[0]!.payload as Submission).mood).toBe('good');
    expect(repo.getSubmission(run.id, 'users/alice')!.messageName).toBe(posts[0]!.messageName);
  });

  it('edits an existing submission while the run is open and updates the card', async () => {
    const { repo, adapter, service } = makeStack();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');

    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    const result = await service.submit(run.id, 'users/alice', 'Alice', withBlocker('Stuck on infra'));
    expect(result).toEqual({ ok: true, late: false, edited: true });

    const sub = repo.getSubmission(run.id, 'users/alice')!;
    expect(sub.editedAt).not.toBeNull();
    expect(sub.mood).toBe('meh');
    expect(adapter.posts.filter((p) => p.kind === 'update')).toHaveLength(1);
    expect(adapter.posts.filter((p) => p.kind === 'submission')).toHaveLength(1);
  });

  it('rejects edits after close, unknown runs and non-participants', async () => {
    const { repo, service } = makeStack();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');

    expect(await service.submit(999, 'users/alice', 'Alice', ANSWERS)).toEqual({
      ok: false,
      reason: 'run_not_found',
    });
    expect(await service.submit(run.id, 'users/mallory', 'Mallory', ANSWERS)).toEqual({
      ok: false,
      reason: 'not_a_participant',
    });

    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    repo.closeRun(run.id);
    expect(await service.submit(run.id, 'users/alice', 'Alice', ANSWERS)).toEqual({
      ok: false,
      reason: 'already_submitted',
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
      edited: false,
    });
  });

  it('opens blockers from blocker answers and auto-resolves on the next clean submission', async () => {
    const { repo, service } = makeStack();
    const standup = seedStandup(repo);

    const run1 = repo.createRun(standup.id, '2026-06-09', 'k1');
    await service.submit(run1.id, 'users/alice', 'Alice', withBlocker('Waiting on API keys'));
    expect(repo.listOpenBlockers(standup.id).map((b) => b.text)).toEqual(['Waiting on API keys']);

    const run2 = repo.createRun(standup.id, '2026-06-10', 'k2');
    await service.submit(run2.id, 'users/alice', 'Alice', ANSWERS);
    expect(repo.listOpenBlockers(standup.id)).toHaveLength(0);
  });

  it('re-derives blockers on edit without resolving older ones', async () => {
    const { repo, service } = makeStack();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');

    await service.submit(run.id, 'users/alice', 'Alice', withBlocker('Blocker A'));
    await service.submit(run.id, 'users/alice', 'Alice', withBlocker('Blocker B'));
    expect(repo.listOpenBlockers(standup.id).map((b) => b.text)).toEqual(['Blocker B']);

    // editing to blocker-free clears today's blocker but doesn't resolve history
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    expect(repo.listOpenBlockers(standup.id)).toHaveLength(0);
  });

  it('skips today only before submitting', () => {
    const { repo, service } = makeStack();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');

    expect(service.skipToday(run.id, 'users/alice')).toBe('skipped');
    expect(repo.listRunParticipants(run.id).find((p) => p.userName === 'users/alice')?.skippedAt).not.toBeNull();
    expect(service.skipToday(999, 'users/alice')).toBe('not_found');
  });

  it('prefills yesterday from the previous today, and full answers when editing', async () => {
    const { repo, service } = makeStack();
    const standup = seedStandup(repo);
    const run1 = repo.createRun(standup.id, '2026-06-09', 'k1');
    await service.submit(run1.id, 'users/alice', 'Alice', ANSWERS);

    const run2 = repo.createRun(standup.id, '2026-06-10', 'k2');
    expect(service.getPrefill(standup, run2, 'users/alice')).toEqual([
      'Start billing webhooks', // previous "today"
      '',
      '',
    ]);
    expect(service.getPrefill(standup, run2, 'users/bob')).toEqual(['', '', '']);

    await service.submit(run2.id, 'users/alice', 'Alice', withBlocker('Stuck'));
    expect(service.getPrefill(standup, run2, 'users/alice')).toEqual([
      'Worked on infra',
      'More infra',
      'Stuck',
    ]);
  });

  it('builds summaries with away/skip handling and open blockers', async () => {
    const { repo, service } = makeStack();
    const standup = seedStandup(repo);
    repo.upsertParticipant({ standupId: standup.id, userName: 'users/dave', displayName: 'Dave' });
    repo.setParticipantVacation(standup.id, 'users/dave', true);
    const run = repo.createRun(standup.id, '2026-06-10', 'key');

    await service.submit(run.id, 'users/alice', 'Alice', withBlocker('Stuck on infra'));
    await service.submit(run.id, 'users/carol', 'Carol', ANSWERS); // optional
    service.skipToday(run.id, 'users/bob');

    const summary = service.buildSummary(run.id);
    expect(summary.mandatoryTotal).toBe(1); // bob skipped + dave on vacation excluded
    expect(summary.mandatorySubmitted).toBe(1);
    expect(summary.missingMandatory).toEqual([]);
    expect(summary.away.sort()).toEqual(['Bob', 'Dave']);
    expect(summary.optionalSubmitted).toBe(1);
    expect(summary.openBlockers).toBe(1);
  });
});
