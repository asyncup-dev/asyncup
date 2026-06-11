import Database from 'better-sqlite3';
import type {
  Admin,
  Answer,
  Blocker,
  Mood,
  Participant,
  Run,
  RunParticipant,
  RunStatus,
  Standup,
  Submission,
} from '../core/types.js';

/**
 * Versioned migrations tracked via PRAGMA user_version.
 * Never edit an existing entry — append a new one.
 */
const MIGRATIONS: string[] = [
  // 1 — initial schema (v0.1)
  `
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
`,
  // 2 — feature round: custom questions, vacation/skip, admins, blockers,
  //     editable submissions, multiple standups per space
  `
CREATE TABLE standups_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  space_name TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt_time TEXT NOT NULL DEFAULT '09:30',
  deadline_time TEXT NOT NULL DEFAULT '11:30',
  reminder_minutes_before INTEGER NOT NULL DEFAULT 60,
  timezone TEXT NOT NULL,
  days TEXT NOT NULL DEFAULT 'mon,tue,wed,thu,fri',
  questions TEXT,
  mood_enabled INTEGER NOT NULL DEFAULT 1,
  digest_enabled INTEGER NOT NULL DEFAULT 0,
  ai_enabled INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO standups_new (id, tenant_id, space_name, name, prompt_time, deadline_time,
  reminder_minutes_before, timezone, days, active, created_at)
SELECT id, tenant_id, space_name, name, prompt_time, deadline_time,
  reminder_minutes_before, timezone, days, active, created_at FROM standups;
DROP TABLE standups;
ALTER TABLE standups_new RENAME TO standups;
CREATE INDEX idx_standups_space ON standups(tenant_id, space_name);

ALTER TABLE participants ADD COLUMN on_vacation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE run_participants ADD COLUMN on_vacation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE run_participants ADD COLUMN skipped_at TEXT;

CREATE TABLE submissions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  answers TEXT NOT NULL,
  mood TEXT,
  late INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT NOT NULL,
  edited_at TEXT,
  message_name TEXT,
  UNIQUE (run_id, user_name)
);
INSERT INTO submissions_new (id, run_id, user_name, display_name, answers, mood, late, submitted_at)
SELECT id, run_id, user_name, display_name,
  json_array(
    json_object('question', 'What did you do yesterday?', 'answer', yesterday),
    json_object('question', 'What will you do today?', 'answer', today),
    json_object('question', 'Any blockers?', 'answer', blockers)
  ),
  mood, late, submitted_at FROM submissions;
DROP TABLE submissions;
ALTER TABLE submissions_new RENAME TO submissions;

CREATE TABLE standup_admins (
  standup_id INTEGER NOT NULL REFERENCES standups(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY (standup_id, user_name)
);
CREATE TABLE blockers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  standup_id INTEGER NOT NULL REFERENCES standups(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  text TEXT NOT NULL,
  opened_run_id INTEGER NOT NULL REFERENCES runs(id),
  opened_date TEXT NOT NULL,
  resolved_run_id INTEGER REFERENCES runs(id),
  resolved_date TEXT
);
CREATE INDEX idx_blockers_open ON blockers(standup_id) WHERE resolved_run_id IS NULL;
`,
];

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
    questions: row.questions ? JSON.parse(row.questions) : null,
    moodEnabled: !!row.mood_enabled,
    digestEnabled: !!row.digest_enabled,
    aiEnabled: !!row.ai_enabled,
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
    onVacation: !!row.on_vacation,
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
    onVacation: !!row.on_vacation,
    promptedAt: row.prompted_at ?? null,
    remindedAt: row.reminded_at ?? null,
    skippedAt: row.skipped_at ?? null,
  };
}

function toSubmission(row: any): Submission {
  return {
    id: row.id,
    runId: row.run_id,
    userName: row.user_name,
    displayName: row.display_name,
    answers: JSON.parse(row.answers),
    mood: (row.mood as Mood) ?? null,
    late: !!row.late,
    submittedAt: row.submitted_at,
    editedAt: row.edited_at ?? null,
    messageName: row.message_name ?? null,
  };
}

function toBlocker(row: any): Blocker {
  return {
    id: row.id,
    standupId: row.standup_id,
    userName: row.user_name,
    displayName: row.display_name,
    text: row.text,
    openedRunId: row.opened_run_id,
    openedDate: row.opened_date,
    resolvedRunId: row.resolved_run_id ?? null,
    resolvedDate: row.resolved_date ?? null,
  };
}

export class Repo {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    let version = this.db.pragma('user_version', { simple: true }) as number;
    // v0.1 databases predate versioning but already have the initial schema.
    if (version === 0) {
      const existing = this.db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'standups'`)
        .get();
      if (existing) {
        version = 1;
        this.db.pragma('user_version = 1');
      }
    }
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.pragma(`user_version = ${i + 1}`);
      })();
    }
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

  listStandupsBySpace(tenantId: string, spaceName: string): Standup[] {
    return this.db
      .prepare('SELECT * FROM standups WHERE tenant_id = ? AND space_name = ? AND active = 1 ORDER BY id')
      .all(tenantId, spaceName)
      .map(toStandup);
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
      Pick<
        Standup,
        | 'name'
        | 'promptTime'
        | 'deadlineTime'
        | 'reminderMinutesBefore'
        | 'timezone'
        | 'days'
        | 'questions'
        | 'moodEnabled'
        | 'digestEnabled'
        | 'aiEnabled'
        | 'active'
      >
    >,
  ): void {
    const mapping: Record<string, string> = {
      name: 'name',
      promptTime: 'prompt_time',
      deadlineTime: 'deadline_time',
      reminderMinutesBefore: 'reminder_minutes_before',
      timezone: 'timezone',
      days: 'days',
      questions: 'questions',
      moodEnabled: 'mood_enabled',
      digestEnabled: 'digest_enabled',
      aiEnabled: 'ai_enabled',
      active: 'active',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      sets.push(`${mapping[key]} = ?`);
      if (key === 'questions') values.push(value === null ? null : JSON.stringify(value));
      else values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
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

  setParticipantVacation(standupId: number, userName: string, onVacation: boolean): boolean {
    const result = this.db
      .prepare('UPDATE participants SET on_vacation = ? WHERE standup_id = ? AND user_name = ? AND active = 1')
      .run(onVacation ? 1 : 0, standupId, userName);
    return result.changes > 0;
  }

  /** DM self-service: toggles vacation in every standup the user is part of. */
  setVacationForUser(userName: string, onVacation: boolean): number {
    return this.db
      .prepare('UPDATE participants SET on_vacation = ? WHERE user_name = ? AND active = 1')
      .run(onVacation ? 1 : 0, userName).changes;
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

  // --- admins ---

  addAdmin(standupId: number, userName: string, displayName: string): void {
    this.db
      .prepare(
        `INSERT INTO standup_admins (standup_id, user_name, display_name) VALUES (?, ?, ?)
         ON CONFLICT (standup_id, user_name) DO UPDATE SET display_name = excluded.display_name`,
      )
      .run(standupId, userName, displayName);
  }

  removeAdmin(standupId: number, userName: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM standup_admins WHERE standup_id = ? AND user_name = ?')
        .run(standupId, userName).changes > 0
    );
  }

  listAdmins(standupId: number): Admin[] {
    return this.db
      .prepare('SELECT * FROM standup_admins WHERE standup_id = ? ORDER BY display_name')
      .all(standupId)
      .map((row: any) => ({
        standupId: row.standup_id,
        userName: row.user_name,
        displayName: row.display_name,
      }));
  }

  isAdmin(standupId: number, userName: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM standup_admins WHERE standup_id = ? AND user_name = ?')
      .get(standupId, userName);
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
        `INSERT INTO run_participants (run_id, user_name, display_name, timezone, mandatory, on_vacation)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const p of this.listParticipants(standupId)) {
        insert.run(runId, p.userName, p.displayName, p.timezone, p.mandatory ? 1 : 0, p.onVacation ? 1 : 0);
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

  listRunsBetween(standupId: number, fromDate: string, toDate: string): Run[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE standup_id = ? AND date >= ? AND date <= ? ORDER BY date')
      .all(standupId, fromDate, toDate)
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

  markSkipped(runId: number, userName: string, at: string): boolean {
    return (
      this.db
        .prepare('UPDATE run_participants SET skipped_at = ? WHERE run_id = ? AND user_name = ?')
        .run(at, runId, userName).changes > 0
    );
  }

  // --- submissions ---

  createSubmission(input: {
    runId: number;
    userName: string;
    displayName: string;
    answers: Answer[];
    mood: Mood | null;
    late: boolean;
    submittedAt: string;
  }): Submission {
    const result = this.db
      .prepare(
        `INSERT INTO submissions (run_id, user_name, display_name, answers, mood, late, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.userName,
        input.displayName,
        JSON.stringify(input.answers),
        input.mood,
        input.late ? 1 : 0,
        input.submittedAt,
      );
    return this.getSubmissionById(Number(result.lastInsertRowid))!;
  }

  updateSubmission(id: number, answers: Answer[], mood: Mood | null, editedAt: string): Submission {
    this.db
      .prepare('UPDATE submissions SET answers = ?, mood = ?, edited_at = ? WHERE id = ?')
      .run(JSON.stringify(answers), mood, editedAt, id);
    return this.getSubmissionById(id)!;
  }

  setSubmissionMessageName(id: number, messageName: string): void {
    this.db.prepare('UPDATE submissions SET message_name = ? WHERE id = ?').run(messageName, id);
  }

  getSubmissionById(id: number): Submission | null {
    const row = this.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
    return row ? toSubmission(row) : null;
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

  /** The user's most recent submission for this standup, before the given run. */
  getPreviousSubmission(standupId: number, userName: string, beforeRunId: number): Submission | null {
    const row = this.db
      .prepare(
        `SELECT sub.* FROM submissions sub
         JOIN runs r ON r.id = sub.run_id
         WHERE r.standup_id = ? AND sub.user_name = ? AND sub.run_id != ?
         ORDER BY r.date DESC LIMIT 1`,
      )
      .get(standupId, userName, beforeRunId);
    return row ? toSubmission(row) : null;
  }

  listSubmissionsBetween(
    standupId: number,
    fromDate: string,
    toDate: string,
  ): { submission: Submission; runDate: string }[] {
    return this.db
      .prepare(
        `SELECT sub.*, r.date AS run_date FROM submissions sub
         JOIN runs r ON r.id = sub.run_id
         WHERE r.standup_id = ? AND r.date >= ? AND r.date <= ?
         ORDER BY r.date, sub.submitted_at`,
      )
      .all(standupId, fromDate, toDate)
      .map((row: any) => ({ submission: toSubmission(row), runDate: row.run_date }));
  }

  // --- blockers ---

  openBlocker(input: {
    standupId: number;
    userName: string;
    displayName: string;
    text: string;
    runId: number;
    date: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO blockers (standup_id, user_name, display_name, text, opened_run_id, opened_date)
         VALUES (@standupId, @userName, @displayName, @text, @runId, @date)`,
      )
      .run(input);
  }

  /** Used when a submission is edited: re-derive its blockers from scratch. */
  deleteBlockersOpenedBy(runId: number, userName: string): void {
    this.db.prepare('DELETE FROM blockers WHERE opened_run_id = ? AND user_name = ?').run(runId, userName);
  }

  resolveBlockersFor(standupId: number, userName: string, runId: number, date: string): number {
    return this.db
      .prepare(
        `UPDATE blockers SET resolved_run_id = ?, resolved_date = ?
         WHERE standup_id = ? AND user_name = ? AND resolved_run_id IS NULL AND opened_run_id != ?`,
      )
      .run(runId, date, standupId, userName, runId).changes;
  }

  listOpenBlockers(standupId: number): Blocker[] {
    return this.db
      .prepare(
        'SELECT * FROM blockers WHERE standup_id = ? AND resolved_run_id IS NULL ORDER BY opened_date',
      )
      .all(standupId)
      .map(toBlocker);
  }

  countBlockersOpenedBetween(standupId: number, fromDate: string, toDate: string): number {
    return (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM blockers WHERE standup_id = ? AND opened_date >= ? AND opened_date <= ?',
        )
        .get(standupId, fromDate, toDate) as { n: number }
    ).n;
  }

  countBlockersResolvedBetween(standupId: number, fromDate: string, toDate: string): number {
    return (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM blockers WHERE standup_id = ? AND resolved_date >= ? AND resolved_date <= ?',
        )
        .get(standupId, fromDate, toDate) as { n: number }
    ).n;
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
