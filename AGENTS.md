# AGENTS.md

How work gets done in AsyncUp, for coding agents and people alike. AsyncUp is an
open-source (MIT), self-hosted async standup app for Google Chat: a Bun +
Express server, a React web app, a JSON API, an MCP server and VitePress docs.
`CLAUDE.md` imports this file; edit this one.

## Commands

| Task | Command |
| --- | --- |
| Install | `bun install` |
| Run locally without Google | `ADAPTER=fake bun run dev` |
| Server tests (100% line and function coverage) | `bun run test:coverage` |
| Server typecheck | `bun run typecheck` |
| Web tests and typecheck | `bun run web:test`, `bun run web:typecheck` |
| Web build | `bun run web:build` |
| Docs | `bun run docs:build` |
| Website (landing page + docs + OpenAPI) | `bun run site:build` |

Tests that start a server bind a local port.

## Layout

```
src/core          domain logic, platform-agnostic (no Google types)
src/adapters      Google Chat adapter: events, cards, dialogs
src/api           JSON API; src/api/spec holds the zod schemas and routes the OpenAPI document is built from
src/mcp           MCP server and tools
src/db            repository and migrations (SQLite and Postgres)
src/integrations  Google Directory, Groups and Calendar
web/src           React web app (TanStack Router and Query, vitest)
docs              VitePress docs, published at /docs/
site              landing page, published at the site root
specs             feature specs (see below)
```

## How we work: spec first

Changes are sized, and the size decides the process.

| Change | Process |
| --- | --- |
| Bug fix or small change with no new behaviour | No spec. Write a failing test, then the fix. |
| Feature, or any change people will notice | A spec in `specs/`, approved before any code. |
| Schema, API, permission or cross-cutting change | A spec with its Design section filled in, approved before any code. |

The flow for a feature:

1. **Spec.** Copy `specs/TEMPLATE.md` to `specs/NNN-short-name.md` (next free
   number). Fill in the problem, stories, acceptance criteria, non-goals,
   design impact and open questions. Keep it to about a page.
2. **Questions, not assumptions.** Anything unclear goes under Open questions as
   `[NEEDS CLARIFICATION: …]` and is asked. Work does not start while one is open.
3. **Design.** For any change to the web app, Chat cards or dialogs, the
   website or the docs layout, draw it in Figma first (see below) and link
   the frames in the spec.
4. **Approval.** The maintainer approves the spec and the Figma frames. Approval
   is explicit; answering a question is not approval.
5. **Build.** Each acceptance criterion maps to at least one test. Name the
   test so the link is obvious.
6. **Sync.** Before the PR is ready: Figma re-synced to what was actually
   built, docs updated, website updated, spec status set to Done.
7. **PR.** One PR per spec, linking it. One PR in flight at a time.

Specs are working documents. Once shipped, the code, the tests, the OpenAPI
document and the docs are the record; the spec is not kept in step afterwards.

## Definition of done

A change is done when every applicable line holds:

- [ ] Server tests pass with 100% line and function coverage; web tests pass.
- [ ] Both typechecks are clean.
- [ ] Each acceptance criterion in the spec has a passing test.
- [ ] **Figma** "AsyncUp v2 — Product Design"
      (https://www.figma.com/design/OQfcL61rbaGakS2FjBKasI) matches what was
      built, for every screen, card, dialog, website or docs page the change
      touched, including mobile and dark frames where they exist.
- [ ] **Docs** (`docs/guide/`) describe any change people will notice, and
      `bun run docs:build` passes.
- [ ] **Website** (`site/`) is updated when a feature it describes changes or a
      headline feature ships, and `bun run site:build` passes.
- [ ] The layout works from 390px to 1440px wide.
- [ ] The spec's status is Done.

If a line can't be met (for example, no Figma access), stop and say so. Don't
skip it silently.

## Rules for the code

- **British English** in UI text, Chat messages, docs and code comments.
- **Core stays platform-free.** `src/core` talks to Google only through the
  `ChatAdapter` interface and the integrations.
- **Scheduling state lives in the database.** Ticks are idempotent; the process
  can restart at any time without double-sending.
- **Migrations.** Every schema change is a new migration added to both
  `SQLITE_MIGRATIONS` and `POSTGRES_MIGRATIONS`. Never edit a shipped one.
- **One contract.** API request and response shapes are zod schemas in
  `src/api/spec/schemas.ts`; every route is listed in `src/api/spec/routes.ts`.
  The web app imports its types from there. Tests fail when the two drift.
- **Permissions.** Every API route, MCP tool, Chat command and core check asks
  for a permission from `src/core/permissions.ts`. The web app hides what the
  caller's `/me` permissions don't allow, rather than letting it fail.
- **Privacy.** Self-hosted means nothing leaves the install by default: no
  third-party services, no in-app LLM. Anonymous moods stay anonymous for every
  role.
- **Layout.** Page layouts follow the content area and components follow their
  own width (CSS container queries), not the window. Responsive rules sit at
  the end of `web/src/styles.css`.
- **Comments** explain a non-obvious why, in one short line. Match the
  surrounding code's naming and density.
- **Dependencies.** Add one only when the change needs it, at its latest stable
  version.

## Pull requests

- `main` is protected; everything lands by PR and squash merge.
- Titles are short, sentence case, and say what changes, like the existing
  `git log`. The body says what and why, lists the changes and how they were
  checked, and links the spec.
- Keep each PR to one spec or one fix.
- No AI attribution anywhere: commits, PRs, code, comments or docs.

## Never

- Guess at a requirement. Ask.
- Push to `main`, force-push a shared branch, or skip hooks.
- Commit secrets, `.env` values, tokens or personal data. The repository is public.
- Name a company or customer that runs AsyncUp in code, docs or history.
