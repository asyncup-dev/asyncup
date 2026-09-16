import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Express, Request, Response } from 'express';
import type { DateTime } from 'luxon';
import type { Principal } from '../api/principal.js';
import type { BlockerService } from '../core/blocker-service.js';
import { bearerToken } from '../core/http.js';
import type { SettingsService } from '../core/settings.js';
import type { StandupService } from '../core/standup-service.js';
import type { McpToken } from '../core/types.js';
import type { Repo } from '../db/repo.js';
import { authenticateMcpToken } from './tokens.js';
import { buildMcpServer } from './tools.js';

export interface McpDeps {
  repo: Repo;
  settings: SettingsService;
  blockers: BlockerService;
  service: StandupService | null;
  tenantId: string;
  version: string;
  now: () => DateTime;
}

/** Who a token acts as — service tokens and admins' personal tokens see the tenant. */
export async function principalForToken(repo: Repo, t: McpToken): Promise<Principal> {
  const user = t.ownerUserName ? { userName: t.ownerUserName, email: '', name: t.ownerDisplayName ?? t.ownerUserName } : null;
  if (t.kind === 'service' || t.ownerAdmin) return { kind: 'admin', via: 'token', tenantId: t.tenantId, user, managedStandupIds: [] };
  const managed = (await repo.listStandupsAdministeredBy(t.ownerUserName!)).map((s) => s.id);
  return { kind: managed.length ? 'manager' : 'member', via: 'token', tenantId: t.tenantId, user, managedStandupIds: managed };
}

/**
 * Streamable HTTP at /mcp. Stateless: a fresh McpServer per request, scoped
 * to the token, so any replica can answer and nothing is kept in memory.
 */
export function registerMcp(app: Express, deps: McpDeps): void {
  const handler = createMcpHandler(
    async (ctx) => {
      const token = ctx.authInfo!.extra!.token as McpToken;
      return buildMcpServer(deps, token, await principalForToken(deps.repo, token));
    },
    { legacy: 'stateless' },
  );
  const node = toNodeHandler(handler);

  app.all('/mcp', async (req: Request, res: Response) => {
    if (!(await deps.settings.get()).mcpEnabled) {
      res.status(503).json({ error: { code: 'mcp_disabled', message: 'The MCP server is switched off. An admin can enable it under Settings › MCP server.' } });
      return;
    }
    const auth = await authenticateMcpToken(deps.repo, bearerToken(req), deps.now());
    if (!auth.ok) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="asyncup-mcp"');
      res.status(401).json({ error: { code: 'unauthenticated', message: `MCP token ${auth.reason}.` } });
      return;
    }
    if (auth.token.tenantId !== deps.tenantId) {
      res.status(401).json({ error: { code: 'unauthenticated', message: 'MCP token belongs to another tenant.' } });
      return;
    }
    const withAuth = req as Request & { auth?: AuthInfo };
    withAuth.auth = {
      token: auth.token.tokenHash,
      clientId: String(auth.token.id),
      scopes: auth.token.scopes.split(','),
      expiresAt: Math.floor(Date.parse(auth.token.expiresAt) / 1000),
      extra: { token: auth.token },
    };
    await node(withAuth, res, req.body);
  });
}
