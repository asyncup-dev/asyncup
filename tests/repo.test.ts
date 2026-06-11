import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Repo } from '../src/db/repo.js';
import { makeStack, seedStandup, ANSWERS, TENANT } from './helpers.js';

describe('Repo', () => {
  it('creates and lists standups by space — several per space allowed', async () => {
    const { repo } = await makeStack();
    const first = await seedStandup(repo);
    const second = await repo.createStandup({
      tenantId: TENANT,
      spaceName: 'spaces/team',
      name: 'Design Standup',
      timezone: 'UTC',
    });
    const list = await repo.listStandupsBySpace(TENANT, 'spaces/team');
    expect(list.map((s) => s.id)).toEqual([first.id, second.id]);
    expect(await repo.listStandupsBySpace('other-tenant', 'spaces/team')).toEqual([]);
    expect(first.questions).toBeNull();
    expect(first.moodEnabled).toBe(true);
    expect(first.digestEnabled).toBe(false);
  });

  it('updates standup fields selectively, including questions JSON', async () => {
    const { repo } = await makeStack();
    const standup = await seedStandup(repo);
    await repo.updateStandup(standup.id, {
      promptTime: '08:00',
      questions: ['What shipped?', 'Blockers?'],
      aiEnabled: true,
    });
    const updated = (await repo.getStandupById(standup.id))!;
    expect(updated.promptTime).toBe('08:00');
    expect(updated.questions).toEqual(['What shipped?', 'Blockers?']);
    expect(updated.aiEnabled).toBe(true);
    await repo.updateStandup(standup.id, { questions: null });
    expect((await repo.getStandupById(standup.id))!.questions).toBeNull();
  });

  it('manages participants: mandatory, vacation, soft remove', async () => {
    const { repo } = await makeStack();
    const standup = await seedStandup(repo);
    expect(await repo.listParticipants(standup.id)).toHaveLength(3);

    expect(await repo.setParticipantVacation(standup.id, 'users/alice', true)).toBe(true);
    expect(
      (await repo.listParticipants(standup.id)).find((p) => p.userName === 'users/alice')?.onVacation,
    ).toBe(true);
    expect(await repo.setVacationForUser('users/alice', false)).toBe(1);

    expect(await repo.removeParticipant(standup.id, 'users/bob')).toBe(true);
    expect(await repo.listParticipants(standup.id)).toHaveLength(2);
  });

  it('manages admins', async () => {
    const { repo } = await makeStack();
    const standup = await seedStandup(repo);
    expect(await repo.listAdmins(standup.id)).toEqual([]);
    await repo.addAdmin(standup.id, 'users/ashish', 'Ashish');
    expect(await repo.isAdmin(standup.id, 'users/ashish')).toBe(true);
    expect(await repo.isAdmin(standup.id, 'users/alice')).toBe(false);
    expect(await repo.removeAdmin(standup.id, 'users/ashish')).toBe(true);
    expect(await repo.listAdmins(standup.id)).toEqual([]);
  });

  it('snapshots the roster (incl. vacation) when a run is created', async () => {
    const { repo } = await makeStack();
    const standup = await seedStandup(repo);
    await repo.setParticipantVacation(standup.id, 'users/carol', true);
    const run = await repo.createRun(standup.id, '2026-06-10', 'k');
    const roster = await repo.listRunParticipants(run.id);
    expect(roster).toHaveLength(3);
    expect(roster.find((p) => p.userName === 'users/carol')?.onVacation).toBe(true);

    await repo.removeParticipant(standup.id, 'users/alice');
    expect(await repo.listRunParticipants(run.id)).toHaveLength(3);
  });

  it('stores submissions with answers JSON, supports edits and message names', async () => {
    const { repo } = await makeStack();
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, '2026-06-10', 'k');
    const sub = await repo.createSubmission({
      runId: run.id,
      userName: 'users/alice',
      displayName: 'Alice',
      answers: ANSWERS.answers,
      mood: ANSWERS.mood,
      late: false,
      submittedAt: '2026-06-10T10:00:00Z',
    });
    expect(sub.answers).toHaveLength(3);
    expect(sub.editedAt).toBeNull();

    await repo.setSubmissionMessageName(sub.id, 'messages/abc');
    const edited = await repo.updateSubmission(
      sub.id,
      [{ question: 'What did you do yesterday?', answer: 'Changed my mind' }],
      'great',
      '2026-06-10T10:30:00Z',
    );
    expect(edited.answers[0]!.answer).toBe('Changed my mind');
    expect(edited.mood).toBe('great');
    expect(edited.editedAt).toBe('2026-06-10T10:30:00Z');
    expect(edited.messageName).toBe('messages/abc');

    await expect(
      repo.createSubmission({
        runId: run.id,
        userName: 'users/alice',
        displayName: 'Alice',
        answers: ANSWERS.answers,
        mood: null,
        late: false,
        submittedAt: '2026-06-10T11:00:00Z',
      }),
    ).rejects.toThrow();
  });

  it('finds the previous submission for prefill', async () => {
    const { repo } = await makeStack();
    const standup = await seedStandup(repo);
    const run1 = await repo.createRun(standup.id, '2026-06-09', 'k1');
    const run2 = await repo.createRun(standup.id, '2026-06-10', 'k2');
    await repo.createSubmission({
      runId: run1.id,
      userName: 'users/alice',
      displayName: 'Alice',
      answers: ANSWERS.answers,
      mood: 'good',
      late: false,
      submittedAt: '2026-06-09T10:00:00Z',
    });
    expect((await repo.getPreviousSubmission(standup.id, 'users/alice', run2.id))?.runId).toBe(run1.id);
    expect(await repo.getPreviousSubmission(standup.id, 'users/bob', run2.id)).toBeNull();
  });

  it('tracks blocker lifecycle', async () => {
    const { repo } = await makeStack();
    const standup = await seedStandup(repo);
    const run1 = await repo.createRun(standup.id, '2026-06-09', 'k1');
    const run2 = await repo.createRun(standup.id, '2026-06-10', 'k2');

    await repo.openBlocker({
      standupId: standup.id,
      userName: 'users/alice',
      displayName: 'Alice',
      text: 'Waiting on API keys',
      runId: run1.id,
      date: '2026-06-09',
    });
    expect(await repo.listOpenBlockers(standup.id)).toHaveLength(1);
    expect(await repo.countBlockersOpenedBetween(standup.id, '2026-06-08', '2026-06-14')).toBe(1);

    expect(await repo.resolveBlockersFor(standup.id, 'users/alice', run2.id, '2026-06-10')).toBe(1);
    expect(await repo.listOpenBlockers(standup.id)).toHaveLength(0);
    expect(await repo.countBlockersResolvedBetween(standup.id, '2026-06-08', '2026-06-14')).toBe(1);
  });

  it('migrates a v0.1 database in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asyncup-mig-'));
    const dbPath = join(dir, 'standup.db');
    try {
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE standups (
          id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, space_name TEXT NOT NULL,
          name TEXT NOT NULL, prompt_time TEXT NOT NULL DEFAULT '09:30',
          deadline_time TEXT NOT NULL DEFAULT '11:30', reminder_minutes_before INTEGER NOT NULL DEFAULT 60,
          timezone TEXT NOT NULL, days TEXT NOT NULL DEFAULT 'mon,tue,wed,thu,fri',
          active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (tenant_id, space_name));
        CREATE TABLE participants (standup_id INTEGER NOT NULL, user_name TEXT NOT NULL,
          display_name TEXT NOT NULL, timezone TEXT, mandatory INTEGER NOT NULL DEFAULT 1,
          active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (standup_id, user_name));
        CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, standup_id INTEGER NOT NULL,
          date TEXT NOT NULL, thread_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (standup_id, date));
        CREATE TABLE run_participants (run_id INTEGER NOT NULL, user_name TEXT NOT NULL,
          display_name TEXT NOT NULL, timezone TEXT, mandatory INTEGER NOT NULL,
          prompted_at TEXT, reminded_at TEXT, PRIMARY KEY (run_id, user_name));
        CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL,
          user_name TEXT NOT NULL, display_name TEXT NOT NULL, yesterday TEXT NOT NULL,
          today TEXT NOT NULL, blockers TEXT NOT NULL, mood TEXT NOT NULL,
          late INTEGER NOT NULL DEFAULT 0, submitted_at TEXT NOT NULL, UNIQUE (run_id, user_name));
        CREATE TABLE dm_spaces (user_name TEXT PRIMARY KEY, space_name TEXT NOT NULL);
        INSERT INTO standups (tenant_id, space_name, name, timezone) VALUES ('default', 'spaces/x', 'Old Standup', 'UTC');
        INSERT INTO runs (standup_id, date, thread_key, status) VALUES (1, '2026-06-01', 'k', 'closed');
        INSERT INTO submissions (run_id, user_name, display_name, yesterday, today, blockers, mood, late, submitted_at)
          VALUES (1, 'users/alice', 'Alice', 'Did X', 'Will do Y', 'none', 'good', 0, '2026-06-01T10:00:00Z');
      `);
      raw.close();

      const repo = await Repo.sqlite(dbPath);
      const standup = (await repo.listStandupsBySpace('default', 'spaces/x'))[0]!;
      expect(standup.name).toBe('Old Standup');
      expect(standup.moodEnabled).toBe(true);
      const sub = (await repo.getSubmission(1, 'users/alice'))!;
      expect(sub.answers).toEqual([
        { question: 'What did you do yesterday?', answer: 'Did X' },
        { question: 'What will you do today?', answer: 'Will do Y' },
        { question: 'Any blockers?', answer: 'none' },
      ]);
      expect(sub.mood).toBe('good');
      // v2 features work on the migrated DB
      await repo.addAdmin(standup.id, 'users/ashish', 'Ashish');
      expect(await repo.isAdmin(standup.id, 'users/ashish')).toBe(true);
      await repo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caches DM spaces', async () => {
    const { repo } = await makeStack();
    expect(await repo.getDmSpace('users/alice')).toBeNull();
    await repo.setDmSpace('users/alice', 'spaces/dm1');
    await repo.setDmSpace('users/alice', 'spaces/dm2');
    expect(await repo.getDmSpace('users/alice')).toBe('spaces/dm2');
  });
});
