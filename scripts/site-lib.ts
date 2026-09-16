import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Pure helpers for the site build (scripts/build-site.ts), kept separate so
 * they can be unit-tested without spawning VitePress.
 */

/** A one-line HTML page that forwards an old docs URL to its new home. */
export function redirectStub(target: string): string {
  const safe = target.replace(/"/g, '&quot;');
  return `<!doctype html><meta charset="utf-8"><title>Moved</title><link rel="canonical" href="${safe}"><meta http-equiv="refresh" content="0; url=${safe}"><p>This page moved to <a href="${safe}">${safe}</a>.</p>\n`;
}

/** Every built docs page as a path relative to the docs dist root, e.g. "guide/handbook.html". */
export function docsPages(distDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === 'assets') continue;
        walk(full);
      } else if (name.endsWith('.html')) {
        out.push(relative(distDir, full).split('\\').join('/'));
      }
    }
  };
  walk(distDir);
  return out.sort();
}

/**
 * Where the docs used to live (site root) → where they live now (/docs/),
 * for the project-site deployment whose old links are in the wild. The docs
 * home itself is skipped: the landing page owns the root now.
 */
export function legacyRedirects(pages: string[]): { from: string; to: string }[] {
  return pages
    .filter((p) => p !== 'index.html' && p !== '404.html')
    .map((p) => {
      const depth = p.split('/').length - 1;
      const up = '../'.repeat(depth);
      return { from: p, to: `${up}docs/${p.replace(/index\.html$/, '')}` };
    });
}

/** Joins a base path and a relative path with exactly one slash between. */
export function withBase(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
