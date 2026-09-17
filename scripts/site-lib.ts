/**
 * Pure helpers for the site build (scripts/build-site.ts), kept separate so
 * they can be unit-tested without spawning VitePress.
 */

/** Joins a base path and a relative path with exactly one slash between. */
export function withBase(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
