import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setStoredToken, storedToken, TOKEN_KEY } from './api';

function mockFetch(status: number, body: unknown | null, ok = status < 400) {
  const fn = vi.fn(async () => ({
    ok,
    status,
    json: async () => {
      if (body === null) throw new Error('no body');
      return body;
    },
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('sends the CSRF header, JSON bodies and the stored bearer', async () => {
    setStoredToken('op-secret');
    expect(storedToken()).toBe('op-secret');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('op-secret');
    const fetchFn = mockFetch(200, { ok: true });
    await api('/settings', { method: 'PATCH', body: { mcpEnabled: true } });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('/api/v1/settings');
    expect(init.method).toBe('PATCH');
    expect(init.headers).toMatchObject({ 'x-requested-with': 'asyncup', authorization: 'Bearer op-secret', 'content-type': 'application/json' });
    expect(init.body).toBe('{"mcpEnabled":true}');
    setStoredToken(null);
    expect(storedToken()).toBeNull();
  });

  it('turns the error envelope into an ApiError and tolerates empty bodies', async () => {
    mockFetch(400, { error: { code: 'invalid', message: 'Name is required.', field: 'name' } });
    await expect(api('/standups', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 400, code: 'invalid', field: 'name', message: 'Name is required.' });
    mockFetch(502, null);
    const err = await api('/spaces').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('http_error');
    mockFetch(204, null);
    await expect(api('/mcp/tokens/1', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('survives storage being unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(storedToken()).toBeNull();
    expect(() => setStoredToken('x')).not.toThrow();
    spy.mockRestore();
    set.mockRestore();
  });
});
