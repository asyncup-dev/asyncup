import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { DateTime } from 'luxon';

export const SESSION_COOKIE = 'asyncup_sess';
const SESSION_DAYS = 7;

/** Who is signed in via Google. `sub` is the Google user id — the same id
 * Chat uses in `users/<id>` resource names, so it links straight to rosters. */
export interface Session {
  sub: string;
  email: string;
  name: string;
  /** Google Workspace admin (super or delegated) at sign-in time. */
  admin: boolean;
  /** Unix seconds. */
  exp: number;
}

function hmac(secretKey: string, payload: string): string {
  return createHmac('sha256', `session:${secretKey}`).update(payload).digest('base64url');
}

export function sealSession(secretKey: string, session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${payload}.${hmac(secretKey, payload)}`;
}

export function openSession(secretKey: string, token: string | undefined): Session | null {
  if (!secretKey || !token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = hmac(secretKey, payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session;
    if (!session.sub || session.exp < DateTime.utc().toSeconds()) return null;
    return session;
  } catch {
    return null;
  }
}

export function newSession(identity: { sub: string; email: string; name: string; admin: boolean }): Session {
  return { ...identity, exp: Math.floor(DateTime.utc().plus({ days: SESSION_DAYS }).toSeconds()) };
}

export function readSessionCookie(req: Request): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}

export function sessionFrom(req: Request, secretKey: string): Session | null {
  return openSession(secretKey, readSessionCookie(req));
}

export function setSessionCookie(res: Response, sealed: string): void {
  // Lax so the OAuth redirect back from Google still carries it.
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sealed}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
