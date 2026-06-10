import { describe, expect, it } from 'vitest';
import { makeStack, seedStandup, ANSWERS, TENANT } from './helpers.js';

describe('Repo', () => {
  it('creates and fetches standups by space and tenant', () => {
    const { repo } = makeStack();
    const standup = seedStandup(repo);
    expect(repo.getStandupBySpace(TENANT, 'spaces/team')?.id).toBe(standup.id);
    expect(repo.getStandupBySpace('other-tenant', 'spaces/team')).toBeNull();
    expect(standup.promptTime).toBe('09:30');
    expect(standup.days).toBe('mon,tue,wed,thu,fri');
  });

  it('updates standup fields selectively', () => {
    const { repo } = makeStack();
    const standup = seedStandup(repo);
    repo.updateStandup(standup.id, { promptTime: '08:00', reminderMinutesBefore: 30 });
    const updated = repo.getStandupById(standup.id)!;
    expect(updated.promptTime).toBe('08:00');
    expect(updated.reminderMinutesBefore).toBe(30);
    expect(updated.deadlineTime).toBe('11:30');
  });

  it('manages participants: upsert, mandatory toggle, soft remove', () => {
    const { repo } = makeStack();
    const standup = seedStandup(repo);
    expect(repo.listParticipants(standup.id)).toHaveLength(3);

    expect(repo.setParticipantMandatory(standup.id, 'users/carol', true)).toBe(true);
    expect(repo.listParticipants(standup.id).find((p) => p.userName === 'users/carol')?.mandatory).toBe(true);
    expect(repo.setParticipantMandatory(standup.id, 'users/nobody', true)).toBe(false);

    expect(repo.removeParticipant(standup.id, 'users/bob')).toBe(true);
    expect(repo.listParticipants(standup.id)).toHaveLength(2);

    // re-adding reactivates
    repo.upsertParticipant({ standupId: standup.id, userName: 'users/bob', displayName: 'Bobby' });
    expect(repo.listParticipants(standup.id).find((p) => p.userName === 'users/bob')?.displayName).toBe(
      'Bobby',
    );
  });

  it('snapshots the roster when a run is created', () => {
    const { repo } = makeStack();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'standup-1-2026-06-10');
    expect(repo.listRunParticipants(run.id)).toHaveLength(3);

    // roster changes after run creation don't affect the snapshot
    repo.removeParticipant(standup.id, 'users/alice');
    expect(repo.listRunParticipants(run.id)).toHaveLength(3);
  });

  it('enforces one submission per user per run', () => {
    const { repo } = makeStack();
    const standup = seedStandup(repo);
    const run = repo.createRun(standup.id, '2026-06-10', 'k');
    repo.createSubmission({
      runId: run.id,
      userName: 'users/alice',
      displayName: 'Alice',
      answers: ANSWERS,
      late: false,
      submittedAt: '2026-06-10T10:00:00Z',
    });
    expect(() =>
      repo.createSubmission({
        runId: run.id,
        userName: 'users/alice',
        displayName: 'Alice',
        answers: ANSWERS,
        late: false,
        submittedAt: '2026-06-10T10:05:00Z',
      }),
    ).toThrow();
    expect(repo.getSubmission(run.id, 'users/alice')?.yesterday).toBe(ANSWERS.yesterday);
  });

  it('lists standups a user participates in', () => {
    const { repo } = makeStack();
    const standup = seedStandup(repo);
    expect(repo.listStandupsForUser('users/alice').map((s) => s.id)).toEqual([standup.id]);
    expect(repo.listStandupsForUser('users/nobody')).toEqual([]);
  });

  it('caches DM spaces', () => {
    const { repo } = makeStack();
    expect(repo.getDmSpace('users/alice')).toBeNull();
    repo.setDmSpace('users/alice', 'spaces/dm1');
    repo.setDmSpace('users/alice', 'spaces/dm2');
    expect(repo.getDmSpace('users/alice')).toBe('spaces/dm2');
  });
});
