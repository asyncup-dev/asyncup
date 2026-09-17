import { describe, expect, it } from 'bun:test';
import { withBase } from '../scripts/site-lib.ts';

describe('site build helpers', () => {
  it('joins base and path with one slash', () => {
    expect(withBase('/', 'docs/')).toBe('/docs/');
    expect(withBase('/asyncup/', '/docs/')).toBe('/asyncup/docs/');
    expect(withBase('/asyncup', 'docs/')).toBe('/asyncup/docs/');
  });
});
