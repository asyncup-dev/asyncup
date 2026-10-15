## What and why

Spec: `specs/NNN-name.md` (or "Bug fix, no spec")

## Changes

## Checks

- [ ] `bun run typecheck && bun run test:coverage` pass (100% lines and functions)
- [ ] `bun run web:typecheck && bun run web:test` pass
- [ ] Each acceptance criterion has a test
- [ ] Figma "AsyncUp v2 — Product Design" matches what was built, or no UI change
- [ ] Docs (`docs/guide/`) updated for anything people will notice, and `bun run docs:build` passes
- [ ] Website (`site/`) updated if a feature it describes changed, and `bun run site:build` passes
- [ ] Layout checked from 390px to 1440px, or no UI change
