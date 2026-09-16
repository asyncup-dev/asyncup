import type { Request, Response, Router } from 'express';
import { MCP_SCOPES, parseScopes, type McpScope } from '../core/mcp-scopes.js';
import type { McpToken } from '../core/types.js';
import { LIMITS } from '../core/validation.js';
import type { Verification } from '../core/verify.js';
import { mcpExpiry, mintMcpToken } from '../mcp/tokens.js';
import type { Principal } from './principal.js';
import { apiError, clampInt, principalOf, type ApiContext } from './shared.js';

function tokenView(t: McpToken) {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    owner: t.ownerUserName ? { userName: t.ownerUserName, displayName: t.ownerDisplayName } : null,
    scopes: parseScopes(t.scopes),
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    expiresAt: t.expiresAt,
    revokedAt: t.revokedAt,
  };
}

/** Admins see every token in the tenant; everyone else only their own. */
async function visibleTokens(ctx: ApiContext, p: Principal): Promise<McpToken[]> {
  if (p.kind === 'admin') return ctx.repo.listMcpTokens(p.tenantId);
  return p.user?.userName ? ctx.repo.listMcpTokens(p.tenantId, p.user.userName) : [];
}

/** Settings › MCP server: tokens, the activity log and the verify gate. */
export function registerMcpRoutes(api: Router, ctx: ApiContext): void {
  const { repo, settings } = ctx;

  api.get('/mcp/tokens', async (req, res) => {
    res.json({ tokens: (await visibleTokens(ctx, principalOf(req))).map(tokenView) });
  });

  // Personal tokens act as the signed-in person; service tokens are read-only and admin-only.
  api.post('/mcp/tokens', async (req: Request, res: Response) => {
    const p = principalOf(req);
    const body = req.body ?? {};
    const name = String(body.name ?? '').trim();
    if (!name || name.length > LIMITS.textMax) {
      apiError(res, 400, 'invalid', 'Name is required.', 'name');
      return;
    }
    const kind = body.kind === undefined ? 'personal' : body.kind;
    if (kind !== 'personal' && kind !== 'service') {
      apiError(res, 400, 'invalid', 'kind must be personal or service.', 'kind');
      return;
    }
    if (kind === 'service' && p.kind !== 'admin') {
      apiError(res, 403, 'forbidden', 'Only admins can create service tokens.');
      return;
    }
    if (kind === 'personal' && !p.user?.userName) {
      apiError(res, 403, 'needs_user', 'A personal token needs a signed-in person, not the operator token.');
      return;
    }
    let scopes: McpScope[];
    if (body.scopes === undefined) {
      scopes = parseScopes((await settings.get()).mcpDefaultScopes);
    } else if (Array.isArray(body.scopes) && body.scopes.every((s: unknown) => MCP_SCOPES.includes(s as McpScope))) {
      scopes = parseScopes(body.scopes.join(','));
    } else {
      apiError(res, 400, 'invalid', `scopes must be a list of ${MCP_SCOPES.join(', ')}.`, 'scopes');
      return;
    }
    if (kind === 'service') scopes = ['read'];
    if (scopes.length === 0) {
      apiError(res, 400, 'invalid', 'Pick at least one scope.', 'scopes');
      return;
    }
    const { secret, hash } = mintMcpToken();
    const now = ctx.now();
    const id = await repo.createMcpToken({
      tenantId: p.tenantId,
      name,
      kind,
      ownerUserName: kind === 'personal' ? p.user!.userName : null,
      ownerDisplayName: kind === 'personal' ? p.user!.name : null,
      ownerAdmin: kind === 'personal' && p.kind === 'admin',
      scopes: scopes.join(','),
      tokenHash: hash,
      createdAt: now.toUTC().toISO()!,
      expiresAt: mcpExpiry(now),
    });
    const url = `${req.protocol}://${req.get('host')}/mcp`;
    res.status(201).json({
      ...tokenView((await repo.getMcpTokenById(id))!),
      secret,
      // Shown once, ready to paste into a client's MCP config.
      config: { url, headers: { Authorization: `Bearer ${secret}` } },
    });
  });

  api.delete('/mcp/tokens/:id', async (req, res) => {
    const p = principalOf(req);
    const id = Number(req.params.id);
    const mine = (await visibleTokens(ctx, p)).some((t) => t.id === id);
    if (!mine || !(await repo.revokeMcpToken(id, ctx.now().toUTC().toISO()!))) {
      apiError(res, 404, 'not_found', 'No such active token.');
      return;
    }
    res.status(204).end();
  });

  api.get('/mcp/activity', async (req, res) => {
    const p = principalOf(req);
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const tokenIds = p.kind === 'admin' ? undefined : (await visibleTokens(ctx, p)).map((t) => t.id);
    res.json({ activity: await repo.listMcpActivity(p.tenantId, { tokenIds, limit }) });
  });

  api.post('/verify/mcp', async (req, res) => {
    const p = principalOf(req);
    if (p.kind !== 'admin') {
      apiError(res, 403, 'forbidden', 'Admins only.');
      return;
    }
    const s = await settings.get();
    const tokens = (await repo.listMcpTokens(p.tenantId)).filter((t) => !t.revokedAt);
    const lastActivityAt = await repo.lastMcpActivityAt(p.tenantId);
    const checkedAt = ctx.now().toUTC().toISO()!;
    const result: Verification = !s.mcpEnabled
      ? { state: 'fail', detail: 'The MCP server is switched off — enable it, then create a token.', checkedAt }
      : tokens.length === 0
        ? { state: 'fail', detail: 'The MCP server is on but no token exists yet — create one to connect a client.', checkedAt }
        : {
            state: 'pass',
            detail: lastActivityAt
              ? `The MCP server is on with ${tokens.length} active token(s); the last call was at ${lastActivityAt}.`
              : `The MCP server is on with ${tokens.length} active token(s); no client has called it yet.`,
            checkedAt,
            data: { tokens: tokens.length, lastActivityAt },
          };
    res.json(result);
  });
}
