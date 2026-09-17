import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { withBase } from './site-lib.ts';

/**
 * Assembles the public site: the landing page at the root, the VitePress
 * docs under /docs/, and the logo the Chat app config points at.
 *
 *   SITE_BASE=/ bun run site:build          # https://asyncup-dev.github.io/
 *   SITE_BASE=/asyncup/ bun run site:build  # a fork's project-site path
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
console.log(`[site] built ${out} for base ${base}`);
