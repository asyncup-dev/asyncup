import type { Repo } from '../db/repo.js';
import type { SettingsService } from './settings.js';
import { validateStandupConfig, type StandupConfigInput } from './standup-config.js';
import { templateById, type StandupTemplate } from './templates.js';
import type { Standup } from './types.js';
import { LIMITS } from './validation.js';

/**
 * The one way a standup comes into being — the chat `setup` command and
 * the JSON API both land here, so naming, duplicate and template rules
 * cannot drift between surfaces.
 */
export interface CreateStandupInput extends Omit<StandupConfigInput, 'escalateUserName' | 'name'> {
  name?: unknown;
  spaceName?: unknown;
  templateId?: unknown;
  /** [{ userName: "users/…", displayName, mandatory? }] */
  participants?: unknown;
}

export interface Creator {
  userName: string;
  displayName: string;
}

export type CreateStandupResult =
  | { ok: true; standup: Standup; template: StandupTemplate | null; siblings: number }
  | { ok: false; code: 'invalid'; field: string; message: string }
  | { ok: false; code: 'duplicate'; duplicate: Standup; message: string };

/** Column defaults, mirrored so cross-field checks can run before the row exists. */
const ROW_DEFAULTS = {
  promptTime: '09:30',
  deadlineTime: '11:30',
  reminderMinutesBefore: 60,
  days: 'mon,tue,wed,thu,fri',
  questions: null,
  moodEnabled: true,
  moodAnonymous: false,
  digestEnabled: false,
  escalateUserName: null,
  escalateDisplayName: null,
  escalateAfterDays: 2,
  webhookUrl: null,
  active: true,
} as const;

const CONFIG_KEYS = [
  'promptTime',
  'deadlineTime',
  'timezone',
  'reminderMinutesBefore',
  'escalateAfterDays',
  'days',
  'webhookUrl',
  'questions',
  'moodEnabled',
  'moodAnonymous',
  'digestEnabled',
] as const;

type Participant = { userName: string; displayName: string; mandatory: boolean };

function parseParticipants(raw: unknown): Participant[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return 'participants must be a list.';
  const out: Participant[] = [];
  for (const item of raw) {
    const userName = String(item?.userName ?? '').trim();
    const displayName = String(item?.displayName ?? '').trim();
    if (!userName.startsWith('users/')) return 'Each participant needs a Chat user resource name (users/…).';
    if (!displayName || displayName.length > LIMITS.textMax) return 'Each participant needs a displayName.';
    if (!out.some((p) => p.userName === userName)) out.push({ userName, displayName, mandatory: item.mandatory !== false });
  }
  return out;
}

export async function createStandup(
  repo: Repo,
  settings: SettingsService,
  tenantId: string,
  input: CreateStandupInput,
  creator: Creator | null = null,
): Promise<CreateStandupResult> {
  const invalid = (field: string, message: string): CreateStandupResult => ({ ok: false, code: 'invalid', field, message });

  const name = String(input.name ?? '').trim();
  if (!name || name.length > LIMITS.textMax) return invalid('name', 'Name is required.');
  const spaceName = String(input.spaceName ?? '').trim();
  if (!spaceName.startsWith('spaces/')) return invalid('spaceName', 'spaceName must be a Chat space resource name (spaces/…).');

  let template: StandupTemplate | null = null;
  if (input.templateId !== undefined && input.templateId !== null) {
    template = templateById(String(input.templateId));
    if (!template) return invalid('templateId', 'Unknown template.');
  }

  const participants = parseParticipants(input.participants);
  if (typeof participants === 'string') return invalid('participants', participants);

  const existing = await repo.listStandupsBySpace(tenantId, spaceName);
  const duplicate = existing.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    return { ok: false, code: 'duplicate', duplicate, message: `This space already has a standup named "${duplicate.name}" (#${duplicate.id}).` };
  }

  // Template first, then the caller's explicit values on top.
  const config: StandupConfigInput = template
    ? {
        promptTime: template.promptTime,
        deadlineTime: template.deadlineTime,
        days: template.days,
        moodEnabled: template.moodEnabled,
        moodAnonymous: template.moodAnonymous,
        digestEnabled: template.digestEnabled,
        ...(template.questions ? { questions: template.questions } : {}),
      }
    : {};
  for (const key of CONFIG_KEYS) if (input[key] !== undefined) config[key] = input[key];

  const timezone = (await settings.get()).defaultTimezone;
  const provisional: Standup = { ...ROW_DEFAULTS, id: 0, tenantId, spaceName, name, timezone };
  const checked = await validateStandupConfig(repo, provisional, config);
  if (!checked.ok) return invalid(checked.field, checked.message);

  const created = await repo.createStandup({ tenantId, spaceName, name, timezone });
  if (Object.keys(checked.fields).length) await repo.updateStandup(created.id, checked.fields);
  for (const p of participants) await repo.upsertParticipant({ standupId: created.id, ...p });
  if (creator) await repo.addAdmin(created.id, creator.userName, creator.displayName);

  return { ok: true, standup: (await repo.getStandupById(created.id))!, template, siblings: existing.length + 1 };
}
