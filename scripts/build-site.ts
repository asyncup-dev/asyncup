import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { docsPages, legacyRedirects, redirectStub, withBase } from './site-lib.ts';

/**
 * Assembles the public site: the landing page at the root, the VitePress
 * docs under /docs/, the logo the Chat app config points at, and — for the
 * project-site target only — redirect stubs at the old docs URLs.
 *
 *   SITE_BASE=/asyncup/ LEGACY_REDIRECTS=1 bun run site:build   # project site
 *   SITE_BASE=/ bun run site:build                                # org site root
 */
const root = join(import.meta.dirname, '..');
const base = process.env.SITE_BASE || '/';
const out = join(root, 'site-dist');
const docsDist = join(root, 'docs', '.vitepress', 'dist');

const docs = Bun.spawnSync(['bun', 'run', 'docs:build'], { cwd: root, env: { ...process.env, DOCS_BASE: withBase(base, 'docs/') }, stdout: 'inherit', stderr: 'inherit' });
if (docs.exitCode !== 0) process.exit(docs.exitCode);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'site'), out, { recursive: true });
cpSync(join(root, 'web', 'src', 'tokens.css'), join(out, 'tokens.css'));
cpSync(join(root, 'web', 'public', 'logo-256.png'), join(out, 'logo-256.png'));
cpSync(join(root, 'web', 'public', 'favicon.svg'), join(out, 'favicon.svg'));
cpSync(docsDist, join(out, 'docs'), { recursive: true });

if (process.env.LEGACY_REDIRECTS) {
  for (const { from, to } of legacyRedirects(docsPages(docsDist))) {
    const file = join(out, from);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, redirectStub(to));
  }
}
console.log(`[site] built ${out} for base ${base}`);
