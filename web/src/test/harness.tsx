import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { App, buildRouter } from '../app';
import type { Me } from '../lib/api';

export const ADMIN: Me = { kind: 'admin', via: 'session', tenantId: 'default', user: { userName: 'users/1', email: 'asha@example.com', name: 'Asha Rao' }, managedStandupIds: [] };
export const MEMBER: Me = { kind: 'member', via: 'session', tenantId: 'default', user: { userName: 'users/2', email: 'bob@example.com', name: 'Bob' }, managedStandupIds: [] };
export const OPERATOR: Me = { kind: 'admin', via: 'token', tenantId: 'default', user: null, managedStandupIds: [] };

type Route = { status?: number; body: unknown | ((init?: RequestInit) => unknown) };

/** A fetch stub keyed by "METHOD path"; unknown calls answer 404 with the API envelope. */
export function stubApi(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input}`;
    calls.push(key);
    const route = routes[key] ?? { status: 404, body: { error: { code: 'not_found', message: 'No such API route.' } } };
    const status = route.status ?? 200;
    const body = typeof route.body === 'function' ? (route.body as (init?: RequestInit) => unknown)(init) : route.body;
    return { ok: status < 400, status, json: async () => body };
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

export function renderApp(path: string) {
  const base = buildRouter();
  const router = createRouter({ ...base.options, history: createMemoryHistory({ initialEntries: [`/app${path}`] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<App router={router} client={client} />);
  return { ...view, router, client };
}
