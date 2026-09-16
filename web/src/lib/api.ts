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
