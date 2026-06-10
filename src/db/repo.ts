import Database from 'better-sqlite3';
import type {
  Mood,
  Participant,
  Run,
  RunParticipant,
  RunStatus,
  Standup,
  Submission,
  SubmissionAnswers,
} from '../core/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS standups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  space_name TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt_time TEXT NOT NULL DEFAULT '09:30',
  deadline_time TEXT NOT NULL DEFAULT '11:30',
  reminder_minutes_before INTEGER NOT NULL DEFAULT 60,
  timezone TEXT NOT NULL,
  days TEXT NOT NULL DEFAULT 'mon,tue,wed,thu,fri',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, space_name)
);

CREATE TABLE IF NOT EXISTS participants (
  standup_id INTEGER NOT NULL REFERENCES standups(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  timezone TEXT,
  mandatory INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (standup_id, user_name)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  standup_id INTEGER NOT NULL REFERENCES standups(id),
  date TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (standup_id, date)
);

CREATE TABLE IF NOT EXISTS run_participants (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  timezone TEXT,
  mandatory INTEGER NOT NULL,
  prompted_at TEXT,
  reminded_at TEXT,
  PRIMARY KEY (run_id, user_name)
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  yesterday TEXT NOT NULL,
  today TEXT NOT NULL,
  blockers TEXT NOT NULL,
  mood TEXT NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT NOT NULL,
  UNIQUE (run_id, user_name)
);

CREATE TABLE IF NOT EXISTS dm_spaces (
  user_name TEXT PRIMARY KEY,
  space_name TEXT NOT NULL
);
`;

function toStandup(row: any): Standup {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    spaceName: row.space_name,
    name: row.name,
    promptTime: row.prompt_time,
    deadlineTime: row.deadline_time,
    reminderMinutesBefore: row.reminder_minutes_before,
    timezone: row.timezone,
    days: row.days,
    active: !!row.active,
  };
}

function toParticipant(row: any): Participant {
  return {
    standupId: row.standup_id,
    userName: row.user_name,
    displayName: row.display_name,
    timezone: row.timezone ?? null,
    mandatory: !!row.mandatory,
    active: !!row.active,
  };
}

function toRun(row: any): Run {
  return {
    id: row.id,
    standupId: row.standup_id,
    date: row.date,
    threadKey: row.thread_key,
    status: row.status as RunStatus,
  };
}

function toRunParticipant(row: any): RunParticipant {
  return {
    runId: row.run_id,
    userName: row.user_name,
    displayName: row.display_name,
    timezone: row.timezone ?? null,
    mandatory: !!row.mandatory,
    promptedAt: row.prompted_at ?? null,
    remindedAt: row.reminded_at ?? null,
  };
}

function toSubmission(row: any): Submission {
  return {
    id: row.id,
    runId: row.run_id,
    userName: row.user_name,
    displayName: row.display_name,
    yesterday: row.yesterday,
    today: row.today,
    blockers: row.blockers,
    mood: row.mood as Mood,
    late: !!row.late,
    submittedAt: row.submitted_at,
  };
}

export class Repo {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- standups ---

  createStandup(input: {
    tenantId: string;
    spaceName: string;
    name: string;
    timezone: string;
  }): Standup {
    const result = this.db
      .prepare(
        `INSERT INTO standups (tenant_id, space_name, name, timezone)
         VALUES (@tenantId, @spaceName, @name, @timezone)`,
      )
      .run(input);
    return this.getStandupById(Number(result.lastInsertRowid))!;
  }

  getStandupById(id: number): Standup | null {
    const row = this.db.prepare('SELECT * FROM standups WHERE id = ?').get(id);
    return row ? toStandup(row) : null;
  }

  getStandupBySpace(tenantId: string, spaceName: string): Standup | null {
    const row = this.db
      .prepare('SELECT * FROM standups WHERE tenant_id = ? AND space_name = ?')
      .get(tenantId, spaceName);
    return row ? toStandup(row) : null;
  }

  listActiveStandups(): Standup[] {
    return this.db
      .prepare('SELECT * FROM standups WHERE active = 1')
      .all()
      .map(toStandup);
  }

  updateStandup(
    id: number,
    fields: Partial<
      Pick<Standup, 'name' | 'promptTime' | 'deadlineTime' | 'reminderMinutesBefore' | 'timezone' | 'days' | 'active'>
    >,
  ): void {
    const mapping: Record<string, string> = {
      name: 'name',
      promptTime: 'prompt_time',
      deadlineTime: 'deadline_time',
      reminderMinutesBefore: 'reminder_minutes_before',
      timezone: 'timezone',
      days: 'days',
      active: 'active',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      sets.push(`${mapping[key]} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE standups SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  // --- participants ---

  upsertParticipant(input: {
    standupId: number;
    userName: string;
    displayName: string;
    mandatory?: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO participants (standup_id, user_name, display_name, mandatory, active)
         VALUES (@standupId, @userName, @displayName, @mandatory, 1)
         ON CONFLICT (standup_id, user_name)
         DO UPDATE SET display_name = @displayName, active = 1`,
      )
      .run({ ...input, mandatory: input.mandatory === false ? 0 : 1 });
  }

  setParticipantMandatory(standupId: number, userName: string, mandatory: boolean): boolean {
    const result = this.db
      .prepare('UPDATE participants SET mandatory = ? WHERE standup_id = ? AND user_name = ? AND active = 1')
      .run(mandatory ? 1 : 0, standupId, userName);
    return result.changes > 0;
  }

  setParticipantTimezone(standupId: number, userName: string, timezone: string | null): boolean {
    const result = this.db
      .prepare('UPDATE participants SET timezone = ? WHERE standup_id = ? AND user_name = ? AND active = 1')
      .run(timezone, standupId, userName);
    return result.changes > 0;
  }

  removeParticipant(standupId: number, userName: string): boolean {
    const result = this.db
      .prepare('UPDATE participants SET active = 0 WHERE standup_id = ? AND user_name = ?')
      .run(standupId, userName);
    return result.changes > 0;
  }

  listParticipants(standupId: number): Participant[] {
    return this.db
      .prepare('SELECT * FROM participants WHERE standup_id = ? AND active = 1 ORDER BY display_name')
      .all(standupId)
      .map(toParticipant);
  }

  /** Standups (across tenants) in which the user is an active participant. */
  listStandupsForUser(userName: string): Standup[] {
    return this.db
      .prepare(
        `SELECT s.* FROM standups s
         JOIN participants p ON p.standup_id = s.id
         WHERE p.user_name = ? AND p.active = 1 AND s.active = 1`,
      )
      .all(userName)
      .map(toStandup);
  }

  // --- runs ---

  /** Creates the run and snapshots the active roster atomically. */
  createRun(standupId: number, date: string, threadKey: string): Run {
    const createTx = this.db.transaction(() => {
      const result = this.db
        .prepare(`INSERT INTO runs (standup_id, date, thread_key) VALUES (?, ?, ?)`)
        .run(standupId, date, threadKey);
      const runId = Number(result.lastInsertRowid);
      const insert = this.db.prepare(
        `INSERT INTO run_participants (run_id, user_name, display_name, timezone, mandatory)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const p of this.listParticipants(standupId)) {
        insert.run(runId, p.userName, p.displayName, p.timezone, p.mandatory ? 1 : 0);
      }
      return runId;
    });
    return this.getRunById(createTx())!;
  }

  getRunById(id: number): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? toRun(row) : null;
  }

  getRun(standupId: number, date: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE standup_id = ? AND date = ?').get(standupId, date);
    return row ? toRun(row) : null;
  }

  listOpenRuns(standupId: number): Run[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE standup_id = ? AND status = 'open'`)
      .all(standupId)
      .map(toRun);
  }

  closeRun(id: number): void {
    this.db.prepare(`UPDATE runs SET status = 'closed' WHERE id = ?`).run(id);
  }

  listRunParticipants(runId: number): RunParticipant[] {
    return this.db
      .prepare('SELECT * FROM run_participants WHERE run_id = ? ORDER BY display_name')
      .all(runId)
      .map(toRunParticipant);
  }

  markPrompted(runId: number, userName: string, at: string): void {
    this.db
      .prepare('UPDATE run_participants SET prompted_at = ? WHERE run_id = ? AND user_name = ?')
      .run(at, runId, userName);
  }

  markReminded(runId: number, userName: string, at: string): void {
    this.db
      .prepare('UPDATE run_participants SET reminded_at = ? WHERE run_id = ? AND user_name = ?')
      .run(at, runId, userName);
  }

  // --- submissions ---

  createSubmission(input: {
    runId: number;
    userName: string;
    displayName: string;
    answers: SubmissionAnswers;
    late: boolean;
    submittedAt: string;
  }): Submission {
    const result = this.db
      .prepare(
        `INSERT INTO submissions (run_id, user_name, display_name, yesterday, today, blockers, mood, late, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.userName,
        input.displayName,
        input.answers.yesterday,
        input.answers.today,
        input.answers.blockers,
        input.answers.mood,
        input.late ? 1 : 0,
        input.submittedAt,
      );
    return toSubmission(
      this.db.prepare('SELECT * FROM submissions WHERE id = ?').get(Number(result.lastInsertRowid)),
    );
  }

  getSubmission(runId: number, userName: string): Submission | null {
    const row = this.db
      .prepare('SELECT * FROM submissions WHERE run_id = ? AND user_name = ?')
      .get(runId, userName);
    return row ? toSubmission(row) : null;
  }

  listSubmissions(runId: number): Submission[] {
    return this.db
      .prepare('SELECT * FROM submissions WHERE run_id = ? ORDER BY submitted_at')
      .all(runId)
      .map(toSubmission);
  }

  // --- DM space cache (used by the Google Chat adapter) ---

  getDmSpace(userName: string): string | null {
    const row = this.db.prepare('SELECT space_name FROM dm_spaces WHERE user_name = ?').get(userName) as
      | { space_name: string }
      | undefined;
    return row?.space_name ?? null;
  }

  setDmSpace(userName: string, spaceName: string): void {
    this.db
      .prepare(
        `INSERT INTO dm_spaces (user_name, space_name) VALUES (?, ?)
         ON CONFLICT (user_name) DO UPDATE SET space_name = excluded.space_name`,
      )
      .run(userName, spaceName);
  }
}
