import { describe, expect, it, vi } from 'vitest';
import { applyTheme, effectiveTheme, readTheme } from './theme';

describe('theme', () => {
  it('stamps the root and remembers the choice; system clears both', () => {
    expect(readTheme()).toBe('system');
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(readTheme()).toBe('dark');
    expect(effectiveTheme()).toBe('dark');
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(readTheme()).toBe('system');
  });

  it('resolves system through the media query', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    expect(effectiveTheme()).toBe('dark');
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    expect(effectiveTheme()).toBe('light');
    vi.unstubAllGlobals();
  });

  it('keeps working when storage throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readTheme()).toBe('system');
    expect(() => applyTheme('light')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('light');
    get.mockRestore();
    set.mockRestore();
  });
});
