/** JSON API client for /api/v1: session cookie by default, or a stored operator token. */

export const TOKEN_KEY = 'asyncup.token';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}

export function storedToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode or storage disabled: the token lives for this page only.
  }
}

export async function api<T>(path: string, init: Omit<RequestInit, 'body'> & { body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    // Browser sessions must prove the call came from our own front-end.
    'x-requested-with': 'asyncup',
    ...(init.headers as Record<string, string> | undefined),
  };
  const token = storedToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`/api/v1${path}`, { ...init, headers, body, credentials: 'same-origin' });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; field?: string } } | null;
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status}).`, err?.field);
  }
  return data as T;
}

export interface Me {
  kind: 'admin' | 'manager' | 'member';
  via: 'session' | 'token';
  tenantId: string;
  user: { userName: string | null; email: string; name: string } | null;
  managedStandupIds: number[];
}

export interface AuthMethods {
  google: boolean;
  saml: boolean;
  token: boolean;
}

export interface StandupSummary {
  id: number;
  name: string;
  spaceName: string;
  active: boolean;
  schedule: { promptTime: string; deadlineTime: string; timezone: string; days: string[]; reminderMinutesBefore: number };
  people: { total: number; mandatory: number };
  today: { date: string; status: 'open' | 'closed' | null; submitted: number; expected: number; missing: { userName: string; displayName: string }[] };
  permissions: { manage: boolean };
}

export interface Verification {
  state: 'pass' | 'fail';
  detail: string;
  checkedAt: string;
  data?: Record<string, unknown>;
}

export interface Settings {
  chat: { audience: string; serviceAccount: { set: boolean; email: string | null; clientId: string | null } };
  workspace: { defaultTimezone: string; calendarOoo: boolean; workspaceAdminEmail: string };
  signIn: {
    tokenSignIn: boolean;
    google: { clientId: string; clientSecret: { set: boolean }; on: boolean };
    saml: { entityId: string; ssoUrl: string; cert: { set: boolean }; adminAttribute: string; adminGroup: string; on: boolean };
  };
  setup: { complete: boolean; chatConfigured: boolean; signInConfigured: boolean };
}

export interface ChatHealth {
  audience: 'set' | 'unset';
  serviceAccount: 'set' | 'unset';
  lastEventAt: string | null;
  lastRejectedAt: string | null;
}

/** Public, outside /api/v1: the connection state without secrets. */
export async function chatHealth(): Promise<ChatHealth> {
  const res = await fetch('/health/chat', { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, 'http_error', `Request failed (${res.status}).`);
  return (await res.json()) as ChatHealth;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  questions: string[] | null;
  days: string[];
  promptTime: string;
  deadlineTime: string;
  moodEnabled: boolean;
  moodAnonymous: boolean;
  digestEnabled: boolean;
}

export interface Space {
  name: string;
  displayName: string;
  standups: { id: number; name: string }[];
}

export interface Person {
  userName: string;
  displayName: string;
}

export interface TodayRun {
  date: string;
  status: 'open' | 'closed' | null;
  expected: number;
  submitted: { userName: string; displayName: string; submittedAt: string; late: boolean; mood: string | null }[];
  waiting: { userName: string; displayName: string; mandatory: boolean; remindedAt: string | null }[];
  away: { userName: string; displayName: string; reason: 'skipped' | 'vacation' }[];
  teamMood: number | null;
}

export const MOOD_EMOJI: Record<string, string> = { great: '😄', good: '🙂', okay: '😐', meh: '😕', struggling: '😫' };

export interface StandupDetail extends StandupSummary {
  questions: string[];
  mood: { enabled: boolean; anonymous: boolean };
  digestEnabled: boolean;
  escalation: { afterDays: number; contact: Person | null };
  webhook: { configured: boolean };
  participants: (Person & { mandatory: boolean; timezone: string | null; onVacation: boolean })[];
  admins: Person[];
}

export interface RunListItem {
  date: string;
  status: 'open' | 'closed';
  submitted: number;
  expected: number;
  missing: Person[];
}

export interface RunDetail {
  date: string;
  status: 'open' | 'closed';
  submitted: number;
  expected: number;
  missing: Person[];
  submissions: { userName: string; displayName: string; submittedAt: string; editedAt: string | null; late: boolean; mood: string | null; answers: { question: string; answer: string }[] }[];
  teamMood: number | null;
}

export interface BlockerView {
  id: number;
  standup: { id: number; name: string };
  owner: Person;
  text: string;
  openedDate: string;
  resolvedDate: string | null;
  resolvedBy: string | null;
  escalatedAt: string | null;
  status: 'open' | 'acknowledged' | 'resolved';
  tags: (Person & { acknowledgedAt: string | null })[];
  updates: (Person & { text: string; at: string })[];
}

export interface WeekPoint {
  label: string;
  participationPct: number | null;
  mood: number | null;
  blockersOpened: number;
  blockersResolved: number;
}
