import { PERMISSIONS } from '../../core/permission-catalogue.js';
import { z } from 'zod';
import { SESSION_COOKIE } from '../../auth/session.js';
import { APP_VERSION } from '../../version.js';
import { COMMON_ERRORS, ROUTES, type Access, type RouteSpec } from './routes.js';
import { registry } from './schemas.js';

const REF = (id: string) => `#/components/schemas/${id}`;

const ACCESS_NOTE: Record<Access, string> = {
  public: 'No sign-in needed.',
  any: 'Any signed-in caller.',
  person: 'A signed-in person with a Chat identity; the operator token cannot act as one.',
  manager: 'Admins, and managers of the standup or person concerned.',
  admin: 'Workspace admins and the operator token.',
};

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No content',
  400: 'Invalid input; `error.field` names it',
  401: 'Not signed in, or a bad bearer token',
  403: 'Not allowed for this caller, a policy refused it, or a browser request without the CSRF header',
  404: 'Not found, or not visible to the caller',
  409: 'Conflicts with the current state',
  429: 'Rate limited',
  502: 'Google Chat did not answer',
  503: 'Not available on this server',
};

/** A schema as JSON Schema, pointing at components for anything named. */
function jsonSchema(schema: z.ZodType): object {
  const id = registry.get(schema)?.id;
  if (id) return { $ref: REF(id) };
  // Named schemas come out as local $defs; every one of them is already a component.
  const { $schema: _, $defs: __, ...rest } = z.toJSONSchema(schema, { metadata: registry, unrepresentable: 'any' }) as Record<string, unknown>;
  return JSON.parse(JSON.stringify(rest).replaceAll('"#/$defs/', '"#/components/schemas/'));
}

function operation(r: RouteSpec) {
  const parameters = [
    ...Object.entries(r.params ?? {}).map(([name, p]) => ({ name, in: 'path', required: true, description: p.description, schema: jsonSchema(p.schema) })),
    ...Object.entries(r.query ?? {}).map(([name, p]) => ({ name, in: 'query', required: false, description: p.description, schema: jsonSchema(p.schema) })),
  ];
  const responses: Record<string, object> = {};
  for (const [status, body] of Object.entries(r.responses)) {
    const description = STATUS_TEXT[Number(status)]!;
    if (body === null) responses[status] = { description };
    else if (body === 'csv') responses[status] = { description, content: { 'text/csv': { schema: { type: 'string' } } } };
    else responses[status] = { description, content: { 'application/json': { schema: jsonSchema(body) } } };
  }
  const errors = [...(r.errors ?? []), ...(r.access === 'public' ? [] : COMMON_ERRORS)].sort();
  for (const status of errors) responses[status] = { description: STATUS_TEXT[status]!, content: { 'application/json': { schema: { $ref: REF('Error') } } } };
  return {
    operationId: `${r.method}${r.path.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))}`,
    summary: r.summary,
    description: r.permission ? `${ACCESS_NOTE[r.access]} Needs the “${PERMISSIONS[r.permission].label}” permission (\`${r.permission}\`).` : ACCESS_NOTE[r.access],
    ...(r.permission ? { 'x-permission': r.permission } : {}),
    tags: [r.tag],
    ...(r.access === 'public' ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(r.body) } } } } : {}),
    responses,
  };
}

/** The JSON API as an OpenAPI 3.1 document, built from the same schemas the tests hold the server to. */
export function buildOpenApi(): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(registry, { uri: REF, unrepresentable: 'any' }) as { schemas: Record<string, Record<string, unknown>> };
  for (const s of Object.values(schemas)) {
    delete s.$schema;
    delete s.$id;
  }
  const paths: Record<string, Record<string, object>> = {};
  for (const r of ROUTES) {
    const path = r.path.replace(/:(\w+)/g, '{$1}');
    paths[path] = { ...paths[path], [r.method]: operation(r) };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'AsyncUp API',
      version: APP_VERSION,
      description: 'The JSON API the AsyncUp web app uses. Browser sessions must send `X-Requested-With: asyncup` on requests that change state.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearer: [] }, { session: [] }],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'The operator token, while token sign-in is on.' },
        session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE, description: 'A Google or SAML sign-in session.' },
      },
    },
  };
}
