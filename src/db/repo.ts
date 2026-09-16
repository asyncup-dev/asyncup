import { PostgresDriver, SqliteDriver, type Driver } from './driver.js';
import type {
  Admin,
  Answer,
  Blocker,
  BlockerTag,
  BlockerUpdate,
  Mood,
  Participant,
  Poll,
  PollVote,
  Run,
  RunParticipant,
  RunStatus,
  ScimUser,
  Standup,
  Submission,
} from '../core/types.js';

/**
 * SQLite migrations tracked via PRAGMA user_version.
 * Never edit an existing entry — append a new one (and mirror it for Postgres).
 */
export const SQLITE_MIGRATIONS: string[] = [
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
  // 3 — calendar OOO sync, anonymous mood, blocker escalation
  `
CREATE TABLE user_emails (
  user_name TEXT PRIMARY KEY,
  email TEXT NOT NULL
);
ALTER TABLE standups ADD COLUMN mood_anonymous INTEGER NOT NULL DEFAULT 0;
ALTER TABLE standups ADD COLUMN escalate_user_name TEXT;
ALTER TABLE standups ADD COLUMN escalate_display_name TEXT;
ALTER TABLE standups ADD COLUMN escalate_after_days INTEGER NOT NULL DEFAULT 2;
ALTER TABLE blockers ADD COLUMN escalated_at TEXT;
`,
  // 4 — blocker collaboration: tags, acknowledgments, updates, explicit resolve
  `
CREATE TABLE blocker_tags (
  blocker_id INTEGER NOT NULL REFERENCES blockers(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  tagged_by TEXT NOT NULL,
  tagged_at TEXT NOT NULL,
  acknowledged_at TEXT,
  last_nudged_at TEXT,
  PRIMARY KEY (blocker_id, user_name)
);
CREATE TABLE blocker_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id INTEGER NOT NULL REFERENCES blockers(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE blockers ADD COLUMN resolved_by TEXT;
CREATE INDEX idx_blockers_unresolved ON blockers(standup_id) WHERE resolved_date IS NULL;
`,
  // 5 — app settings move from env vars into the database
  `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`,
  // 6 — outbound webhooks per standup
  `
ALTER TABLE standups ADD COLUMN webhook_url TEXT;
`,
  // 7 — polls
  `
CREATE TABLE polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  standup_id INTEGER NOT NULL REFERENCES standups(id),
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_display TEXT NOT NULL,
  message_name TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE poll_votes (
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  voted_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, user_name)
);
`,
  // 8 — SCIM provisioning
  `
CREATE TABLE scim_users (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  user_name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email TEXT,
  chat_user_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  // 9 — drop idx_blockers_open: every open-blocker query filters on
  //     resolved_date IS NULL (idx_blockers_unresolved); this one was never used
  `
DROP INDEX IF EXISTS idx_blockers_open;
`,
  // 10 — in-app AI summaries removed (an MCP server replaces them): drop the
  //      per-standup flag and forget any stored provider keys
  `
ALTER TABLE standups DROP COLUMN ai_enabled;
DELETE FROM settings WHERE key IN ('llmProvider', 'llmApiKey', 'llmModel');
`,
];

/**
 * Postgres installs are new as of schema v3, so migration 1 is the full
 * current schema. Future migrations append to BOTH dialect arrays and the
 * version numbers stay aligned via padding entries.
 */
export const POSTGRES_MIGRATIONS: string[] = [
  `
CREATE TABLE standups (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  mood_anonymous INTEGER NOT NULL DEFAULT 0,
  digest_enabled INTEGER NOT NULL DEFAULT 0,
  ai_enabled INTEGER NOT NULL DEFAULT 0,
  escalate_user_name TEXT,
  escalate_display_name TEXT,
  escalate_after_days INTEGER NOT NULL DEFAULT 2,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_standups_space ON standups(tenant_id, space_name);
CREATE TABLE participants (
  standup_id INTEGER NOT NULL REFERENCES standups(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  timezone TEXT,
  mandatory INTEGER NOT NULL DEFAULT 1,
  on_vacation INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (standup_id, user_name)
);
CREATE TABLE runs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  standup_id INTEGER NOT NULL REFERENCES standups(id),
  date TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (standup_id, date)
);
CREATE TABLE run_participants (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  timezone TEXT,
  mandatory INTEGER NOT NULL,
  on_vacation INTEGER NOT NULL DEFAULT 0,
  prompted_at TEXT,
  reminded_at TEXT,
  skipped_at TEXT,
  PRIMARY KEY (run_id, user_name)
);
CREATE TABLE submissions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
CREATE TABLE dm_spaces (
  user_name TEXT PRIMARY KEY,
  space_name TEXT NOT NULL
);
CREATE TABLE standup_admins (
  standup_id INTEGER NOT NULL REFERENCES standups(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY (standup_id, user_name)
);
CREATE TABLE blockers (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  standup_id INTEGER NOT NULL REFERENCES standups(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  text TEXT NOT NULL,
  opened_run_id INTEGER NOT NULL REFERENCES runs(id),
  opened_date TEXT NOT NULL,
  resolved_run_id INTEGER REFERENCES runs(id),
  resolved_date TEXT,
  escalated_at TEXT
);
CREATE INDEX idx_blockers_open ON blockers(standup_id) WHERE resolved_run_id IS NULL;
CREATE TABLE user_emails (
  user_name TEXT PRIMARY KEY,
  email TEXT NOT NULL
);
`,
  // 2, 3 — already included in the initial Postgres schema above
  '',
  '',
  // 4 — blocker collaboration (mirrors the SQLite migration)
  `
CREATE TABLE blocker_tags (
  blocker_id INTEGER NOT NULL REFERENCES blockers(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  tagged_by TEXT NOT NULL,
  tagged_at TEXT NOT NULL,
  acknowledged_at TEXT,
  last_nudged_at TEXT,
  PRIMARY KEY (blocker_id, user_name)
);
CREATE TABLE blocker_updates (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  blocker_id INTEGER NOT NULL REFERENCES blockers(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE blockers ADD COLUMN resolved_by TEXT;
CREATE INDEX idx_blockers_unresolved ON blockers(standup_id) WHERE resolved_date IS NULL;
`,
  // 5 — app settings move from env vars into the database
  `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`,
  // 6 — outbound webhooks per standup
  `
ALTER TABLE standups ADD COLUMN webhook_url TEXT;
`,
  // 7 — polls
  `
CREATE TABLE polls (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  standup_id INTEGER NOT NULL REFERENCES standups(id),
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_display TEXT NOT NULL,
  message_name TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE poll_votes (
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  user_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  voted_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, user_name)
);
`,
  // 8 — SCIM provisioning
  `
CREATE TABLE scim_users (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  user_name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email TEXT,
  chat_user_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  // 9 — drop idx_blockers_open: every open-blocker query filters on
  //     resolved_date IS NULL (idx_blockers_unresolved); this one was never used
  `
DROP INDEX IF EXISTS idx_blockers_open;
`,
  // 10 — in-app AI summaries removed (an MCP server replaces them): drop the
  //      per-standup flag and forget any stored provider keys
  `
ALTER TABLE standups DROP COLUMN ai_enabled;
DELETE FROM settings WHERE key IN ('llmProvider', 'llmApiKey', 'llmModel');
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
    moodAnonymous: !!row.mood_anonymous,
    digestEnabled: !!row.digest_enabled,
    escalateUserName: row.escalate_user_name ?? null,
    escalateDisplayName: row.escalate_display_name ?? null,
    escalateAfterDays: row.escalate_after_days,
    webhookUrl: row.webhook_url ?? null,
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
    resolvedBy: row.resolved_by ?? null,
    escalatedAt: row.escalated_at ?? null,
  };
}

function toBlockerTag(row: any): BlockerTag {
  return {
    blockerId: row.blocker_id,
    userName: row.user_name,
    displayName: row.display_name,
    taggedBy: row.tagged_by,
    taggedAt: row.tagged_at,
    acknowledgedAt: row.acknowledged_at ?? null,
    lastNudgedAt: row.last_nudged_at ?? null,
  };
}

function toBlockerUpdate(row: any): BlockerUpdate {
  return {
    id: row.id,
    blockerId: row.blocker_id,
    userName: row.user_name,
    displayName: row.display_name,
    text: row.text,
    createdAt: row.created_at,
  };
}

function toScimUser(row: any): ScimUser {
  return {
    id: row.id,
    externalId: row.external_id ?? null,
    userName: row.user_name,
    displayName: row.display_name ?? null,
    email: row.email ?? null,
    chatUserName: row.chat_user_name ?? null,
    active: !!row.active,
  };
}

function toPoll(row: any): Poll {
  return {
    id: row.id,
    standupId: row.standup_id,
    question: row.question,
    options: JSON.parse(row.options),
    createdBy: row.created_by,
    createdDisplay: row.created_display,
    messageName: row.message_name ?? null,
    closedAt: row.closed_at ?? null,
  };
}

export class Repo {
  private constructor(private db: Driver) {}

  /** Embedded SQLite — the zero-config default. */
  static async sqlite(dbPath: string): Promise<Repo> {
    const repo = new Repo(new SqliteDriver(dbPath));
    await repo.migrate(SQLITE_MIGRATIONS, true);
    return repo;
  }

  /** Bring-your-own PostgreSQL via connection string. */
  static async postgres(url: string, schema?: string): Promise<Repo> {
    const repo = new Repo(await PostgresDriver.connect(url, schema));
    await repo.migrate(POSTGRES_MIGRATIONS, false);
    return repo;
  }

  private async migrate(migrations: string[], detectLegacy: boolean): Promise<void> {
    let version = await this.db.getVersion();
    // v0.1 SQLite databases predate versioning but already have the initial schema.
    if (detectLegacy && version === 0) {
      const existing = await this.db.get(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'standups'`,
      );
      if (existing) {
        version = 1;
        await this.db.setVersion(1);
      }
    }
    for (let i = version; i < migrations.length; i++) {
      await this.db.transaction(async () => {
        if (migrations[i]!.trim()) await this.db.exec(migrations[i]!);
        await this.db.setVersion(i + 1);
      });
    }
  }

  async ping(): Promise<boolean> {
    return !!(await this.db.get('SELECT 1 AS ok'));
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  // --- standups ---

  async createStandup(input: {
    tenantId: string;
    spaceName: string;
    name: string;
    timezone: string;
  }): Promise<Standup> {
    const id = await this.db.insert(
      'INSERT INTO standups (tenant_id, space_name, name, timezone) VALUES (?, ?, ?, ?)',
      [input.tenantId, input.spaceName, input.name, input.timezone],
    );
    return (await this.getStandupById(id))!;
  }

  async getStandupById(id: number): Promise<Standup | null> {
    const row = await this.db.get('SELECT * FROM standups WHERE id = ?', [id]);
    return row ? toStandup(row) : null;
  }

  /** Active standups in one tenant — what an admin sees. */
  async listStandupsForTenant(tenantId: string): Promise<Standup[]> {
    return (
      await this.db.all('SELECT * FROM standups WHERE tenant_id = ? AND active = 1 ORDER BY id', [tenantId])
    ).map(toStandup);
  }

  /** Active standups this person administers — the manager role is derived from this. */
  async listStandupsAdministeredBy(userName: string): Promise<Standup[]> {
    return (
      await this.db.all(
        `SELECT s.* FROM standups s JOIN standup_admins a ON a.standup_id = s.id
         WHERE a.user_name = ? AND s.active = 1 ORDER BY s.id`,
        [userName],
      )
    ).map(toStandup);
  }

  async listStandupsBySpace(tenantId: string, spaceName: string): Promise<Standup[]> {
    const rows = await this.db.all(
      'SELECT * FROM standups WHERE tenant_id = ? AND space_name = ? AND active = 1 ORDER BY id',
      [tenantId, spaceName],
    );
    return rows.map(toStandup);
  }

  async listActiveStandups(): Promise<Standup[]> {
    return (await this.db.all('SELECT * FROM standups WHERE active = 1')).map(toStandup);
  }

  async updateStandup(
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
        | 'moodAnonymous'
        | 'digestEnabled'
        | 'escalateUserName'
        | 'escalateDisplayName'
        | 'escalateAfterDays'
        | 'webhookUrl'
        | 'active'
      >
    >,
  ): Promise<void> {
    const mapping: Record<string, string> = {
      name: 'name',
      promptTime: 'prompt_time',
      deadlineTime: 'deadline_time',
      reminderMinutesBefore: 'reminder_minutes_before',
      timezone: 'timezone',
      days: 'days',
      questions: 'questions',
      moodEnabled: 'mood_enabled',
      moodAnonymous: 'mood_anonymous',
      digestEnabled: 'digest_enabled',
      escalateUserName: 'escalate_user_name',
      escalateDisplayName: 'escalate_display_name',
      escalateAfterDays: 'escalate_after_days',
      webhookUrl: 'webhook_url',
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
    await this.db.run(`UPDATE standups SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  // --- participants ---

  async upsertParticipant(input: {
    standupId: number;
    userName: string;
    displayName: string;
    mandatory?: boolean;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO participants (standup_id, user_name, display_name, mandatory, active)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (standup_id, user_name)
       DO UPDATE SET display_name = excluded.display_name, active = 1`,
      [input.standupId, input.userName, input.displayName, input.mandatory === false ? 0 : 1],
    );
  }

  async setParticipantMandatory(standupId: number, userName: string, mandatory: boolean): Promise<boolean> {
    const result = await this.db.run(
      'UPDATE participants SET mandatory = ? WHERE standup_id = ? AND user_name = ? AND active = 1',
      [mandatory ? 1 : 0, standupId, userName],
    );
    return result.changes > 0;
  }

  async setParticipantVacation(standupId: number, userName: string, onVacation: boolean): Promise<boolean> {
    const result = await this.db.run(
      'UPDATE participants SET on_vacation = ? WHERE standup_id = ? AND user_name = ? AND active = 1',
      [onVacation ? 1 : 0, standupId, userName],
    );
    return result.changes > 0;
  }

  /** DM self-service: toggles vacation in every standup the user is part of. */
  async setVacationForUser(userName: string, onVacation: boolean): Promise<number> {
    const result = await this.db.run(
      'UPDATE participants SET on_vacation = ? WHERE user_name = ? AND active = 1',
      [onVacation ? 1 : 0, userName],
    );
    return result.changes;
  }

  /** DM self-service: sets the personal timezone in every standup the user is part of. */
  async setTimezoneForUser(userName: string, timezone: string | null): Promise<number> {
    const result = await this.db.run(
      'UPDATE participants SET timezone = ? WHERE user_name = ? AND active = 1',
      [timezone, userName],
    );
    return result.changes;
  }

  async getUserTimezone(userName: string): Promise<string | null> {
    const row = await this.db.get(
      'SELECT timezone FROM participants WHERE user_name = ? AND active = 1 AND timezone IS NOT NULL LIMIT 1',
      [userName],
    );
    return row?.timezone ?? null;
  }

  async removeParticipant(standupId: number, userName: string): Promise<boolean> {
    const result = await this.db.run(
      'UPDATE participants SET active = 0 WHERE standup_id = ? AND user_name = ?',
      [standupId, userName],
    );
    return result.changes > 0;
  }

  async listParticipants(standupId: number): Promise<Participant[]> {
    const rows = await this.db.all(
      'SELECT * FROM participants WHERE standup_id = ? AND active = 1 ORDER BY display_name',
      [standupId],
    );
    return rows.map(toParticipant);
  }

  /** Standups (across tenants) in which the user is an active participant. */
  /** Every active roster row in a tenant, with the standup's name — the Team directory. */
  async listTenantParticipants(tenantId: string): Promise<(Participant & { standupName: string })[]> {
    const rows = await this.db.all(
      `SELECT p.*, s.name AS standup_name FROM participants p JOIN standups s ON s.id = p.standup_id
       WHERE s.tenant_id = ? AND p.active = 1 AND s.active = 1 ORDER BY p.display_name, p.standup_id`,
      [tenantId],
    );
    return rows.map((row: any) => ({ ...toParticipant(row), standupName: row.standup_name }));
  }

  async listUserEmails(): Promise<{ userName: string; email: string }[]> {
    const rows = await this.db.all('SELECT user_name, email FROM user_emails ORDER BY user_name');
    return rows.map((row: any) => ({ userName: row.user_name, email: row.email }));
  }

  async listStandupsForUser(userName: string): Promise<Standup[]> {
    const rows = await this.db.all(
      `SELECT s.* FROM standups s
       JOIN participants p ON p.standup_id = s.id
       WHERE p.user_name = ? AND p.active = 1 AND s.active = 1`,
      [userName],
    );
    return rows.map(toStandup);
  }

  // --- admins ---

  async addAdmin(standupId: number, userName: string, displayName: string): Promise<void> {
    await this.db.run(
      `INSERT INTO standup_admins (standup_id, user_name, display_name) VALUES (?, ?, ?)
       ON CONFLICT (standup_id, user_name) DO UPDATE SET display_name = excluded.display_name`,
      [standupId, userName, displayName],
    );
  }

  async removeAdmin(standupId: number, userName: string): Promise<boolean> {
    const result = await this.db.run(
      'DELETE FROM standup_admins WHERE standup_id = ? AND user_name = ?',
      [standupId, userName],
    );
    return result.changes > 0;
  }

  async listAdmins(standupId: number): Promise<Admin[]> {
    const rows = await this.db.all(
      'SELECT * FROM standup_admins WHERE standup_id = ? ORDER BY display_name',
      [standupId],
    );
    return rows.map((row: any) => ({
      standupId: row.standup_id,
      userName: row.user_name,
      displayName: row.display_name,
    }));
  }

  async isAdmin(standupId: number, userName: string): Promise<boolean> {
    return !!(await this.db.get(
      'SELECT 1 FROM standup_admins WHERE standup_id = ? AND user_name = ?',
      [standupId, userName],
    ));
  }

  // --- runs ---

  /** Creates the run and snapshots the active roster atomically. */
  async createRun(standupId: number, date: string, threadKey: string): Promise<Run> {
    const runId = await this.db.transaction(async () => {
      const id = await this.db.insert(
        'INSERT INTO runs (standup_id, date, thread_key) VALUES (?, ?, ?)',
        [standupId, date, threadKey],
      );
      for (const p of await this.listParticipants(standupId)) {
        await this.db.run(
          `INSERT INTO run_participants (run_id, user_name, display_name, timezone, mandatory, on_vacation)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, p.userName, p.displayName, p.timezone, p.mandatory ? 1 : 0, p.onVacation ? 1 : 0],
        );
      }
      return id;
    });
    return (await this.getRunById(runId))!;
  }

  async getRunById(id: number): Promise<Run | null> {
    const row = await this.db.get('SELECT * FROM runs WHERE id = ?', [id]);
    return row ? toRun(row) : null;
  }

  async getRun(standupId: number, date: string): Promise<Run | null> {
    const row = await this.db.get('SELECT * FROM runs WHERE standup_id = ? AND date = ?', [
      standupId,
      date,
    ]);
    return row ? toRun(row) : null;
  }

  async listOpenRuns(standupId: number): Promise<Run[]> {
    const rows = await this.db.all(`SELECT * FROM runs WHERE standup_id = ? AND status = 'open'`, [
      standupId,
    ]);
    return rows.map(toRun);
  }

  async listRunsBetween(standupId: number, fromDate: string, toDate: string): Promise<Run[]> {
    const rows = await this.db.all(
      'SELECT * FROM runs WHERE standup_id = ? AND date >= ? AND date <= ? ORDER BY date',
      [standupId, fromDate, toDate],
    );
    return rows.map(toRun);
  }

  async listRecentRuns(standupId: number, limit: number): Promise<Run[]> {
    const rows = await this.db.all(
      'SELECT * FROM runs WHERE standup_id = ? ORDER BY date DESC LIMIT ?',
      [standupId, limit],
    );
    return rows.map(toRun);
  }

  async closeRun(id: number): Promise<void> {
    await this.db.run(`UPDATE runs SET status = 'closed' WHERE id = ?`, [id]);
  }

  async listRunParticipants(runId: number): Promise<RunParticipant[]> {
    const rows = await this.db.all(
      'SELECT * FROM run_participants WHERE run_id = ? ORDER BY display_name',
      [runId],
    );
    return rows.map(toRunParticipant);
  }

  async markPrompted(runId: number, userName: string, at: string): Promise<void> {
    await this.db.run('UPDATE run_participants SET prompted_at = ? WHERE run_id = ? AND user_name = ?', [
      at,
      runId,
      userName,
    ]);
  }

  async markReminded(runId: number, userName: string, at: string): Promise<void> {
    await this.db.run('UPDATE run_participants SET reminded_at = ? WHERE run_id = ? AND user_name = ?', [
      at,
      runId,
      userName,
    ]);
  }

  /** Marks the run-level snapshot only (e.g. calendar OOO for a single day). */
  async markRunVacation(runId: number, userName: string): Promise<void> {
    await this.db.run('UPDATE run_participants SET on_vacation = 1 WHERE run_id = ? AND user_name = ?', [
      runId,
      userName,
    ]);
  }

  async markSkipped(runId: number, userName: string, at: string): Promise<boolean> {
    const result = await this.db.run(
      'UPDATE run_participants SET skipped_at = ? WHERE run_id = ? AND user_name = ?',
      [at, runId, userName],
    );
    return result.changes > 0;
  }

  // --- submissions ---

  async createSubmission(input: {
    runId: number;
    userName: string;
    displayName: string;
    answers: Answer[];
    mood: Mood | null;
    late: boolean;
    submittedAt: string;
  }): Promise<Submission> {
    const id = await this.db.insert(
      `INSERT INTO submissions (run_id, user_name, display_name, answers, mood, late, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.runId,
        input.userName,
        input.displayName,
        JSON.stringify(input.answers),
        input.mood,
        input.late ? 1 : 0,
        input.submittedAt,
      ],
    );
    return (await this.getSubmissionById(id))!;
  }

  async updateSubmission(id: number, answers: Answer[], mood: Mood | null, editedAt: string): Promise<Submission> {
    await this.db.run('UPDATE submissions SET answers = ?, mood = ?, edited_at = ? WHERE id = ?', [
      JSON.stringify(answers),
      mood,
      editedAt,
      id,
    ]);
    return (await this.getSubmissionById(id))!;
  }

  async setSubmissionMessageName(id: number, messageName: string): Promise<void> {
    await this.db.run('UPDATE submissions SET message_name = ? WHERE id = ?', [messageName, id]);
  }

  private async getSubmissionById(id: number): Promise<Submission | null> {
    const row = await this.db.get('SELECT * FROM submissions WHERE id = ?', [id]);
    return row ? toSubmission(row) : null;
  }

  async getSubmission(runId: number, userName: string): Promise<Submission | null> {
    const row = await this.db.get('SELECT * FROM submissions WHERE run_id = ? AND user_name = ?', [
      runId,
      userName,
    ]);
    return row ? toSubmission(row) : null;
  }

  async listSubmissions(runId: number): Promise<Submission[]> {
    const rows = await this.db.all('SELECT * FROM submissions WHERE run_id = ? ORDER BY submitted_at', [
      runId,
    ]);
    return rows.map(toSubmission);
  }

  /** The user's most recent submission for this standup, before the given run. */
  async getPreviousSubmission(
    standupId: number,
    userName: string,
    beforeRunId: number,
  ): Promise<Submission | null> {
    const row = await this.db.get(
      `SELECT sub.* FROM submissions sub
       JOIN runs r ON r.id = sub.run_id
       WHERE r.standup_id = ? AND sub.user_name = ? AND sub.run_id != ?
       ORDER BY r.date DESC LIMIT 1`,
      [standupId, userName, beforeRunId],
    );
    return row ? toSubmission(row) : null;
  }

  async listSubmissionsBetween(
    standupId: number,
    fromDate: string,
    toDate: string,
  ): Promise<{ submission: Submission; runDate: string }[]> {
    const rows = await this.db.all(
      `SELECT sub.*, r.date AS run_date FROM submissions sub
       JOIN runs r ON r.id = sub.run_id
       WHERE r.standup_id = ? AND r.date >= ? AND r.date <= ?
       ORDER BY r.date, sub.submitted_at`,
      [standupId, fromDate, toDate],
    );
    return rows.map((row: any) => ({ submission: toSubmission(row), runDate: row.run_date }));
  }

  /** A user's recent submissions across standups, newest first (user console). */
  async listRecentSubmissionsForUser(
    userName: string,
    limit: number,
  ): Promise<{ submission: Submission; runDate: string; standupName: string }[]> {
    const rows = await this.db.all(
      `SELECT sub.*, r.date AS run_date, s.name AS standup_name
       FROM submissions sub
       JOIN runs r ON r.id = sub.run_id
       JOIN standups s ON s.id = r.standup_id
       WHERE sub.user_name = ?
       ORDER BY r.date DESC, sub.id DESC
       LIMIT ?`,
      [userName, limit],
    );
    return rows.map((row: any) => ({
      submission: toSubmission(row),
      runDate: row.run_date,
      standupName: row.standup_name,
    }));
  }

  // --- blockers ---

  async openBlocker(input: {
    standupId: number;
    userName: string;
    displayName: string;
    text: string;
    runId: number;
    date: string;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO blockers (standup_id, user_name, display_name, text, opened_run_id, opened_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.standupId, input.userName, input.displayName, input.text, input.runId, input.date],
    );
  }

  /**
   * Used when a submission is edited: re-derive its blockers from scratch.
   * Blockers that already gathered tags or updates are collaborative — they
   * survive the edit (and keep their FK rows) and need an explicit resolve.
   */
  async deleteBlockersOpenedBy(runId: number, userName: string): Promise<void> {
    await this.db.run(
      `DELETE FROM blockers WHERE opened_run_id = ? AND user_name = ?
         AND NOT EXISTS (SELECT 1 FROM blocker_tags bt WHERE bt.blocker_id = blockers.id)
         AND NOT EXISTS (SELECT 1 FROM blocker_updates bu WHERE bu.blocker_id = blockers.id)`,
      [runId, userName],
    );
  }

  /** Open blockers a user's submission opened in this run (edit re-derivation). */
  async listBlockersOpenedBy(runId: number, userName: string): Promise<Blocker[]> {
    const rows = await this.db.all(
      'SELECT * FROM blockers WHERE opened_run_id = ? AND user_name = ? AND resolved_date IS NULL',
      [runId, userName],
    );
    return rows.map(toBlocker);
  }

  /**
   * Auto-resolve on a clean submission — but only "private" blockers.
   * Tagged blockers and blockers with updates are collaborative and must be
   * resolved explicitly so a clean standup can't silently close them.
   */
  async resolveBlockersFor(standupId: number, userName: string, runId: number, date: string): Promise<number> {
    const result = await this.db.run(
      `UPDATE blockers SET resolved_run_id = ?, resolved_date = ?, resolved_by = 'auto'
       WHERE standup_id = ? AND user_name = ? AND resolved_date IS NULL AND opened_run_id != ?
         AND NOT EXISTS (SELECT 1 FROM blocker_tags bt WHERE bt.blocker_id = blockers.id)
         AND NOT EXISTS (SELECT 1 FROM blocker_updates bu WHERE bu.blocker_id = blockers.id)`,
      [runId, date, standupId, userName, runId],
    );
    return result.changes;
  }

  async resolveBlocker(id: number, date: string, by: string): Promise<boolean> {
    const result = await this.db.run(
      'UPDATE blockers SET resolved_date = ?, resolved_by = ? WHERE id = ? AND resolved_date IS NULL',
      [date, by, id],
    );
    return result.changes > 0;
  }

  async getBlockerById(id: number): Promise<Blocker | null> {
    const row = await this.db.get('SELECT * FROM blockers WHERE id = ?', [id]);
    return row ? toBlocker(row) : null;
  }

  /** Blockers across a tenant's standups, optionally narrowed — the Blockers workspace. */
  async listBlockers(filter: {
    tenantId: string;
    status: 'open' | 'resolved' | 'all';
    standupIds?: number[];
    userName?: string;
  }): Promise<Blocker[]> {
    const where = ['s.tenant_id = ?'];
    const params: unknown[] = [filter.tenantId];
    if (filter.status === 'open') where.push('b.resolved_date IS NULL');
    if (filter.status === 'resolved') where.push('b.resolved_date IS NOT NULL');
    if (filter.standupIds) {
      if (filter.standupIds.length === 0) return [];
      where.push(`b.standup_id IN (${filter.standupIds.map(() => '?').join(', ')})`);
      params.push(...filter.standupIds);
    }
    if (filter.userName) {
      where.push('b.user_name = ?');
      params.push(filter.userName);
    }
    const rows = await this.db.all(
      `SELECT b.* FROM blockers b JOIN standups s ON s.id = b.standup_id
       WHERE ${where.join(' AND ')} ORDER BY b.resolved_date IS NOT NULL, b.opened_date, b.id`,
      params,
    );
    return rows.map(toBlocker);
  }

  async listOpenBlockers(standupId: number): Promise<Blocker[]> {
    const rows = await this.db.all(
      'SELECT * FROM blockers WHERE standup_id = ? AND resolved_date IS NULL ORDER BY opened_date',
      [standupId],
    );
    return rows.map(toBlocker);
  }

  // --- blocker collaboration ---

  async tagBlocker(input: {
    blockerId: number;
    userName: string;
    displayName: string;
    taggedBy: string;
    at: string;
  }): Promise<boolean> {
    const existing = await this.db.get(
      'SELECT 1 FROM blocker_tags WHERE blocker_id = ? AND user_name = ?',
      [input.blockerId, input.userName],
    );
    if (existing) return false;
    await this.db.run(
      `INSERT INTO blocker_tags (blocker_id, user_name, display_name, tagged_by, tagged_at)
       VALUES (?, ?, ?, ?, ?)`,
      [input.blockerId, input.userName, input.displayName, input.taggedBy, input.at],
    );
    return true;
  }

  async listBlockerTags(blockerId: number): Promise<BlockerTag[]> {
    const rows = await this.db.all(
      'SELECT * FROM blocker_tags WHERE blocker_id = ? ORDER BY tagged_at',
      [blockerId],
    );
    return rows.map(toBlockerTag);
  }

  async ackBlockerTag(blockerId: number, userName: string, at: string): Promise<boolean> {
    const result = await this.db.run(
      'UPDATE blocker_tags SET acknowledged_at = ? WHERE blocker_id = ? AND user_name = ? AND acknowledged_at IS NULL',
      [at, blockerId, userName],
    );
    return result.changes > 0;
  }

  async markTagNudged(blockerId: number, userName: string, at: string): Promise<void> {
    await this.db.run(
      'UPDATE blocker_tags SET last_nudged_at = ? WHERE blocker_id = ? AND user_name = ?',
      [at, blockerId, userName],
    );
  }

  /** Unacknowledged tags on open blockers — the daily-nudge worklist. */
  async listUnackedTags(standupId: number): Promise<{ tag: BlockerTag; blocker: Blocker }[]> {
    // The join already carries the blocker columns — no per-row lookups.
    const rows = await this.db.all(
      `SELECT bt.blocker_id, bt.user_name, bt.display_name, bt.tagged_by, bt.tagged_at,
              bt.acknowledged_at, bt.last_nudged_at,
              b.id AS b_id, b.standup_id AS b_standup_id, b.user_name AS b_user_name,
              b.display_name AS b_display_name, b.text AS b_text, b.opened_run_id AS b_opened_run_id,
              b.opened_date AS b_opened_date, b.resolved_run_id AS b_resolved_run_id,
              b.resolved_date AS b_resolved_date, b.resolved_by AS b_resolved_by, b.escalated_at AS b_escalated_at
       FROM blocker_tags bt
       JOIN blockers b ON b.id = bt.blocker_id
       WHERE b.standup_id = ? AND b.resolved_date IS NULL AND bt.acknowledged_at IS NULL`,
      [standupId],
    );
    return rows.map((row: any) => ({
      tag: toBlockerTag(row),
      blocker: toBlocker({
        id: row.b_id,
        standup_id: row.b_standup_id,
        user_name: row.b_user_name,
        display_name: row.b_display_name,
        text: row.b_text,
        opened_run_id: row.b_opened_run_id,
        opened_date: row.b_opened_date,
        resolved_run_id: row.b_resolved_run_id,
        resolved_date: row.b_resolved_date,
        resolved_by: row.b_resolved_by,
        escalated_at: row.b_escalated_at,
      }),
    }));
  }

  async addBlockerUpdate(input: {
    blockerId: number;
    userName: string;
    displayName: string;
    text: string;
    at: string;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO blocker_updates (blocker_id, user_name, display_name, text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [input.blockerId, input.userName, input.displayName, input.text, input.at],
    );
  }

  async listBlockerUpdates(blockerId: number): Promise<BlockerUpdate[]> {
    const rows = await this.db.all(
      'SELECT * FROM blocker_updates WHERE blocker_id = ? ORDER BY created_at',
      [blockerId],
    );
    return rows.map(toBlockerUpdate);
  }

  async countBlockersOpenedBetween(standupId: number, fromDate: string, toDate: string): Promise<number> {
    const row = await this.db.get(
      'SELECT COUNT(*) AS n FROM blockers WHERE standup_id = ? AND opened_date >= ? AND opened_date <= ?',
      [standupId, fromDate, toDate],
    );
    return Number(row.n);
  }

  async countBlockersResolvedBetween(standupId: number, fromDate: string, toDate: string): Promise<number> {
    const row = await this.db.get(
      'SELECT COUNT(*) AS n FROM blockers WHERE standup_id = ? AND resolved_date >= ? AND resolved_date <= ?',
      [standupId, fromDate, toDate],
    );
    return Number(row.n);
  }

  async markBlockerEscalated(id: number, at: string): Promise<void> {
    await this.db.run('UPDATE blockers SET escalated_at = ? WHERE id = ?', [at, id]);
  }


  // --- polls ---

  async createPoll(input: {
    standupId: number;
    question: string;
    options: string[];
    createdBy: string;
    createdDisplay: string;
    at: string;
  }): Promise<Poll> {
    const id = await this.db.insert(
      `INSERT INTO polls (standup_id, question, options, created_by, created_display, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.standupId, input.question, JSON.stringify(input.options), input.createdBy, input.createdDisplay, input.at],
    );
    return (await this.getPollById(id))!;
  }

  async getPollById(id: number): Promise<Poll | null> {
    const row = await this.db.get('SELECT * FROM polls WHERE id = ?', [id]);
    return row ? toPoll(row) : null;
  }

  async setPollMessageName(id: number, messageName: string): Promise<void> {
    await this.db.run('UPDATE polls SET message_name = ? WHERE id = ?', [messageName, id]);
  }

  async closePoll(id: number, at: string): Promise<boolean> {
    const result = await this.db.run('UPDATE polls SET closed_at = ? WHERE id = ? AND closed_at IS NULL', [at, id]);
    return result.changes > 0;
  }

  async listOpenPolls(standupId: number): Promise<Poll[]> {
    const rows = await this.db.all(
      'SELECT * FROM polls WHERE standup_id = ? AND closed_at IS NULL ORDER BY id',
      [standupId],
    );
    return rows.map(toPoll);
  }

  /** Upsert — changing your mind replaces the previous vote. */
  async votePoll(input: { pollId: number; userName: string; displayName: string; optionIndex: number; at: string }): Promise<void> {
    await this.db.run(
      `INSERT INTO poll_votes (poll_id, user_name, display_name, option_index, voted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (poll_id, user_name)
       DO UPDATE SET option_index = excluded.option_index, voted_at = excluded.voted_at, display_name = excluded.display_name`,
      [input.pollId, input.userName, input.displayName, input.optionIndex, input.at],
    );
  }

  async listPollVotes(pollId: number): Promise<PollVote[]> {
    const rows = await this.db.all('SELECT * FROM poll_votes WHERE poll_id = ? ORDER BY voted_at', [pollId]);
    return rows.map((row: any) => ({
      pollId: row.poll_id,
      userName: row.user_name,
      displayName: row.display_name,
      optionIndex: row.option_index,
    }));
  }


  // --- SCIM provisioning ---

  async createScimUser(u: {
    id: string;
    externalId: string | null;
    userName: string;
    displayName: string | null;
    email: string | null;
    chatUserName: string | null;
    active: boolean;
    at: string;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO scim_users (id, external_id, user_name, display_name, email, chat_user_name, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.id, u.externalId, u.userName, u.displayName, u.email, u.chatUserName, u.active ? 1 : 0, u.at, u.at],
    );
  }

  async updateScimUser(
    id: string,
    fields: { externalId?: string | null; userName?: string; displayName?: string | null; email?: string | null; chatUserName?: string | null; active?: boolean },
    at: string,
  ): Promise<void> {
    const mapping: Record<string, string> = {
      externalId: 'external_id',
      userName: 'user_name',
      displayName: 'display_name',
      email: 'email',
      chatUserName: 'chat_user_name',
      active: 'active',
    };
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [at];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      sets.push(`${mapping[key]} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    values.push(id);
    await this.db.run(`UPDATE scim_users SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  async getScimUser(id: string): Promise<ScimUser | null> {
    const row = await this.db.get('SELECT * FROM scim_users WHERE id = ?', [id]);
    return row ? toScimUser(row) : null;
  }

  async findScimUserByUserName(userName: string): Promise<ScimUser | null> {
    const row = await this.db.get('SELECT * FROM scim_users WHERE user_name = ?', [userName]);
    return row ? toScimUser(row) : null;
  }

  async listScimUsers(startIndex: number, count: number): Promise<{ total: number; users: ScimUser[] }> {
    const total = Number((await this.db.get('SELECT COUNT(*) AS n FROM scim_users')).n);
    const rows = await this.db.all('SELECT * FROM scim_users ORDER BY created_at, id LIMIT ? OFFSET ?', [
      count,
      Math.max(0, startIndex - 1),
    ]);
    return { total, users: rows.map(toScimUser) };
  }

  // --- user emails (learned from Chat interaction events) ---

  async setUserEmail(userName: string, email: string): Promise<void> {
    await this.db.run(
      `INSERT INTO user_emails (user_name, email) VALUES (?, ?)
       ON CONFLICT (user_name) DO UPDATE SET email = excluded.email`,
      [userName, email],
    );
  }

  async getUserEmail(userName: string): Promise<string | null> {
    const row = await this.db.get('SELECT email FROM user_emails WHERE user_name = ?', [userName]);
    return row?.email ?? null;
  }

  /** Reverse lookup for email-based identities (SAML, SCIM). */
  async findUserNameByEmail(email: string): Promise<string | null> {
    const row = await this.db.get('SELECT user_name FROM user_emails WHERE email = ? LIMIT 1', [email]);
    return row?.user_name ?? null;
  }

  /** Offboarding (SCIM deactivate): drop the person from every roster. */
  async removeParticipantEverywhere(userName: string): Promise<number> {
    const result = await this.db.run('UPDATE participants SET active = 0 WHERE user_name = ? AND active = 1', [userName]);
    return result.changes;
  }

  // --- settings (key/value, optionally encrypted) ---

  async getSettingValue(key: string): Promise<string | null> {
    const row = await this.db.get('SELECT value FROM settings WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  async getSettingRows(): Promise<{ key: string; value: string; encrypted: boolean }[]> {
    const rows = await this.db.all('SELECT key, value, encrypted FROM settings');
    return rows.map((r: any) => ({ key: r.key, value: r.value, encrypted: !!r.encrypted }));
  }

  async setSetting(key: string, value: string, encrypted: boolean, at: string): Promise<void> {
    await this.db.run(
      `INSERT INTO settings (key, value, encrypted, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = excluded.updated_at`,
      [key, value, encrypted ? 1 : 0, at],
    );
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db.run('DELETE FROM settings WHERE key = ?', [key]);
  }

  // --- DM space cache (used by the Google Chat adapter) ---

  async getDmSpace(userName: string): Promise<string | null> {
    const row = await this.db.get('SELECT space_name FROM dm_spaces WHERE user_name = ?', [userName]);
    return row?.space_name ?? null;
  }

  async setDmSpace(userName: string, spaceName: string): Promise<void> {
    await this.db.run(
      `INSERT INTO dm_spaces (user_name, space_name) VALUES (?, ?)
       ON CONFLICT (user_name) DO UPDATE SET space_name = excluded.space_name`,
      [userName, spaceName],
    );
  }
}
