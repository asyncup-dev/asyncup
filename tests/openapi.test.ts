import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'bun:test';
import { Validator } from '@seriousme/openapi-schema-validator';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { contractCheck, contractViolations } from '../src/api/spec/check.js';
import { buildOpenApi } from '../src/api/spec/openapi.js';
import { findRoute, ROUTES } from '../src/api/spec/routes.js';
import { createServer } from '../src/server.js';
import { makeStack, TENANT } from './helpers.js';

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

function listen(app: express.Express): string {
  const server = app.listen(0);
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function appUnderTest() {
  const stack = await makeStack();
  const router = new EventRouter(stack.commands, stack.service, stack.blockers, stack.repo, TENANT);
  return createServer({
    router,
    scheduler: stack.scheduler,
    repo: stack.repo,
    adapter: stack.adapter,
    blockers: stack.blockers,
    settings: stack.settings,
    dashboardToken: 'op',
    skipVerification: true,
    secretKey: 'k',
    now: stack.clock.now,
  });
}

/** Every route registered on the router that serves /auth/methods, as "get /path". */
function apiRoutes(app: express.Express): string[] {
  const walk = (stack: any[]): string[][] =>
    stack.flatMap((layer: any) => {
      if (layer.route) return [Object.keys(layer.route.methods).map((m) => `${m} ${layer.route.path}`)];
      return layer.handle?.stack ? walk(layer.handle.stack) : [];
    });
  const routers = (app as any).router.stack.filter((l: any) => l.handle?.stack).map((l: any) => walk(l.handle.stack).flat());
  return routers.find((r: string[]) => r.includes('get /auth/methods'))!.sort();
}

describe('OpenAPI document', () => {
  it('is valid OpenAPI 3.1 and served without sign-in', async () => {
    const doc = buildOpenApi();
    const result = await new Validator().validate(doc);
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
    const url = listen(await appUnderTest());
    const res = await fetch(`${url}/api/v1/openapi.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it('documents exactly the routes the server registers', async () => {
    const registered = apiRoutes(await appUnderTest());
    const documented = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(registered).toEqual(documented);
  });

  it('gives every operation a unique id, an Error response for its failures and auth unless public', () => {
    const doc = buildOpenApi() as any;
    const ops = Object.values(doc.paths).flatMap((p: any) => Object.values(p)) as any[];
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(ops.length);
    for (const op of ops) {
      const errors = Object.entries(op.responses).filter(([status]) => Number(status) >= 400);
      for (const [, r] of errors) expect((r as any).content['application/json'].schema).toEqual({ $ref: '#/components/schemas/Error' });
      if (op.security) expect(errors).toEqual([]);
      else expect(errors.map(([s]) => s)).toEqual(expect.arrayContaining(['401', '403', '429']));
    }
    expect(doc.paths['/standups/{id}/export.csv'].get.responses['200'].content).toEqual({ 'text/csv': { schema: { type: 'string' } } });
    expect(doc.paths['/standups/{id}/participants/{userName}'].delete.responses['204']).toEqual({ description: 'No content' });
    expect(findRoute('GET', '/nope')).toBeUndefined();
  });
});

describe('contract check', () => {
  /** A stand-in API whose handlers misbehave on purpose. */
  function rogue(handlers: (r: express.Router) => void) {
    const app = express();
    const api = express.Router();
    api.use(express.json());
    api.use(contractCheck());
    handlers(api);
    api.use((_req, res) => {
      res.status(404).json({ error: { code: 'not_found', message: 'No such API route.' } });
    });
    app.use('/api/v1', api);
    return listen(app);
  }

  it('flags responses, statuses and requests that disagree with the spec', async () => {
    const url = rogue((api) => {
      api.get('/me', (_req, res) => {
        res.json({ kind: 'admin' });
      });
      api.get('/templates', (_req, res) => {
        res.status(202).json({ templates: [] });
      });
      api.get('/standups', (_req, res) => {
        res.status(418).json({ error: { code: 'teapot', message: 'no' } });
      });
      api.get('/people', (_req, res) => {
        res.status(403).json({ oops: true });
      });
      api.get('/undocumented', (_req, res) => {
        res.json({});
      });
      api.post('/blockers/:id/update', (_req, res) => {
        res.json({ result: 'ok' });
      });
      api.delete('/history', (_req, res) => {
        res.status(204).end();
      });
    });
    await fetch(`${url}/api/v1/me`);
    await fetch(`${url}/api/v1/templates`);
    await fetch(`${url}/api/v1/standups`);
    await fetch(`${url}/api/v1/people`);
    await fetch(`${url}/api/v1/undocumented`);
    await fetch(`${url}/api/v1/blockers/1/update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }) });
    await fetch(`${url}/api/v1/history`, { method: 'DELETE' });
    await fetch(`${url}/api/v1/nowhere`);
    const found = contractViolations.splice(0);
    expect(found).toEqual([
      expect.stringMatching(/^GET \/api\/v1\/me → 200: response does not match \(via: /),
      'GET /api/v1/templates → 202: status not declared',
      'GET /api/v1/standups → 418: error status not declared',
      expect.stringMatching(/^GET \/api\/v1\/people → 403: not the Error shape/),
      'GET /api/v1/undocumented → 200: route GET /undocumented is not in the spec',
      expect.stringMatching(/^POST \/api\/v1\/blockers\/1\/update → 200: accepted a request the spec rejects \(text: /),
      'DELETE /api/v1/history → 204: status not declared',
    ]);
  });
});
