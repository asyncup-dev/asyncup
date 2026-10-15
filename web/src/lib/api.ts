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

// Response shapes come from the server's API schemas, the same ones that generate the OpenAPI document.
export type {
  AuthMethods,
  AwayReason,
  Blocker as BlockerView,
  Me,
  Person,
  RunDetail,
  RunListItem,
  Settings,
  StandupDetail,
  StandupSummary,
  Template,
  TimeOffPolicy,
  TodayRun,
  Verification,
  WeekPoint,
} from '../../../src/api/spec/schemas.ts';
import type { AwayReason } from '../../../src/api/spec/schemas.ts';

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

export interface Space {
  name: string;
  displayName: string;
  standups: { id: number; name: string }[];
}

export const AWAY_LABEL: Record<AwayReason, string> = { vacation: 'Vacation', calendar_ooo: 'Calendar out of office', day_off: 'Day off', off_day: 'Not a working day', skipped: 'Skipped' };

export const MOOD_EMOJI: Record<string, string> = { great: '😄', good: '🙂', okay: '😐', meh: '😕', struggling: '😫' };

export const MOOD_LABEL: Record<string, string> = { great: 'Great', good: 'Good', okay: 'Okay', meh: 'Meh', struggling: 'Struggling' };

/** "😕 Meh — “Short night”", as a mood comment reads in the web app. */
export function moodWithComment(mood: string, comment: string): string {
  return `${MOOD_EMOJI[mood] ?? ''} ${MOOD_LABEL[mood] ?? mood} — “${comment}”`;
}

