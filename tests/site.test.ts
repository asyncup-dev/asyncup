import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docsPages, legacyRedirects, redirectStub, withBase } from '../scripts/site-lib.ts';

describe('site build helpers', () => {
  it('writes a forwarding stub with the target escaped', () => {
    const html = redirectStub('../docs/guide/handbook.html');
    expect(html).toContain('http-equiv="refresh" content="0; url=../docs/guide/handbook.html"');
    expect(html).toContain('rel="canonical"');
    expect(redirectStub('x"y')).toContain('x&quot;y');
  });

  it('lists built pages, skipping assets, and maps them to their new home', () => {
    const dist = mkdtempSync(join(tmpdir(), 'asyncup-docs-'));
    mkdirSync(join(dist, 'guide'), { recursive: true });
    mkdirSync(join(dist, 'assets'));
    mkdirSync(join(dist, 'guide', 'deep'));
    for (const f of ['index.html', '404.html', 'guide/handbook.html', 'guide/deep/index.html', 'assets/app.js', 'guide/notes.txt']) writeFileSync(join(dist, f), '');
    const pages = docsPages(dist);
    expect(pages).toEqual(['404.html', 'guide/deep/index.html', 'guide/handbook.html', 'index.html']);
    expect(legacyRedirects(pages)).toEqual([
      { from: 'guide/deep/index.html', to: '../../docs/guide/deep/' },
      { from: 'guide/handbook.html', to: '../docs/guide/handbook.html' },
    ]);
  });

  it('joins base and path with one slash', () => {
    expect(withBase('/', 'docs/')).toBe('/docs/');
    expect(withBase('/asyncup/', '/docs/')).toBe('/asyncup/docs/');
    expect(withBase('/asyncup', 'docs/')).toBe('/asyncup/docs/');
  });
});
