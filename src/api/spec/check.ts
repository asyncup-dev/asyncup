import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';
import { COMMON_ERRORS, findRoute } from './routes.js';
import { ApiError } from './schemas.js';

/** Mismatches between what the server did and what the spec says; the test suite fails on any. */
export const contractViolations: string[] = [];

function issues(schema: z.ZodType, value: unknown): string | null {
  const result = schema.safeParse(value);
  return result.success ? null : result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/**
 * Holds the API to its spec while ASYNCUP_CONTRACT_CHECK is set: a route must
 * be documented, its status declared, its JSON body must match the schema for
 * that status, errors must use the Error shape, and a request the server
 * accepted must match the route's request schema.
 */
export function contractCheck(): RequestHandler {
  return (req, res, next) => {
    let sentJson = false;
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      sentJson = true;
      check(req, res.statusCode, body);
      return json(body);
    };
    res.on('finish', () => {
      if (!sentJson) check(req, res.statusCode, undefined);
    });
    next();
  };
}

function check(req: Request, status: number, body: unknown): void {
  const flag = (what: string): void => {
    contractViolations.push(`${req.method} ${req.originalUrl} → ${status}: ${what}`);
  };
  if (status >= 400 && body !== undefined) {
    const bad = issues(ApiError, body);
    if (bad) flag(`not the Error shape (${bad})`);
  }
  // Errors raised before a route matched (auth, CSRF, unknown path) have no route to check against.
  if (!req.route) return;
  const spec = findRoute(req.method, req.route.path);
  if (!spec) return flag(`route ${req.method} ${req.route.path} is not in the spec`);
  if (status >= 400) {
    const allowed = [...(spec.errors ?? []), ...(spec.access === 'public' ? [] : COMMON_ERRORS)];
    if (!allowed.includes(status)) flag('error status not declared');
    return;
  }
  if (!(status in spec.responses)) return flag('status not declared');
  const declared = spec.responses[status];
  if (declared && declared !== 'csv') {
    const bad = issues(declared, body);
    if (bad) flag(`response does not match (${bad})`);
  }
  if (spec.body) {
    const bad = issues(spec.body, req.body ?? {});
    if (bad) flag(`accepted a request the spec rejects (${bad})`);
  }
}
