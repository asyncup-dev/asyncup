import { createHash } from 'node:crypto';
import type { DateTime } from 'luxon';
import { generateToken } from '../core/crypto.js';
import type { McpToken } from '../core/types.js';
import type { Repo } from '../db/repo.js';

/** Tokens are shown once; only the SHA-256 hex lands in the database. */
export const MCP_TOKEN_PREFIX = 'amcp_';
/** Rolling expiry: every accepted call pushes the deadline out again. */
export const MCP_TOKEN_TTL_DAYS = 90;

export function mintMcpToken(): { secret: string; hash: string } {
  const secret = `${MCP_TOKEN_PREFIX}${generateToken()}`;
  return { secret, hash: hashMcpToken(secret) };
}

export function hashMcpToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function mcpExpiry(now: DateTime): string {
  return now.plus({ days: MCP_TOKEN_TTL_DAYS }).toUTC().toISO()!;
}

export type McpAuthResult = { ok: true; token: McpToken } | { ok: false; reason: 'missing' | 'unknown' | 'revoked' | 'expired' };

/** Resolve a bearer secret to a live token, refreshing its rolling expiry. */
export async function authenticateMcpToken(repo: Repo, secret: string | undefined, now: DateTime): Promise<McpAuthResult> {
  if (!secret || !secret.startsWith(MCP_TOKEN_PREFIX)) return { ok: false, reason: 'missing' };
  const token = await repo.getMcpTokenByHash(hashMcpToken(secret));
  if (!token) return { ok: false, reason: 'unknown' };
  if (token.revokedAt) return { ok: false, reason: 'revoked' };
  if (token.expiresAt <= now.toUTC().toISO()!) return { ok: false, reason: 'expired' };
  const expiresAt = mcpExpiry(now);
  await repo.touchMcpToken(token.id, now.toUTC().toISO()!, expiresAt);
  return { ok: true, token: { ...token, lastUsedAt: now.toUTC().toISO()!, expiresAt } };
}
