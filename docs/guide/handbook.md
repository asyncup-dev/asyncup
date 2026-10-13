# Handbook

Every AsyncUp page in one index, by who you are. Everything here is in the
free, MIT-licensed core.

## You run the server

Follow the setup path in order: [Getting started](./getting-started).

1. [Host](./server-setup) — Docker Compose with automatic HTTPS, PostgreSQL,
   Cloud Run, or a home server.
2. [Google Cloud and the Chat app](./google-chat-setup) — project, APIs,
   service account, the audience rule.
3. [Guided setup and first test](./first-standup) — a private test space, a
   full run, then clean-up.
4. [Roll out to your team](./distribution) — visibility allowlist or a private
   Marketplace listing with admin install.
5. [Directory and group rosters](./directory) — the admin role for the service
   account, rosters that follow a Google Group, Calendar out-of-office.
6. [Sign-in: Google, SAML, SCIM](./enterprise-sso) — including the Google
   Workspace SAML walkthrough.
7. [Operations](./operations) — health checks, upgrades with a backup, restore,
   token rotation, lock-out recovery.

Locked out after switching the operator token off? See
[Operations → Locked out](./operations#locked-out).

## You run standups

- [Web app](./web-app) — the console: standups, People grid, history,
  insights, blockers, reports, team.
- [Commands](./commands) — everything you can do by @mentioning the bot.
- [Personal schedules](./schedules) — personal weeks, days off, time-off
  approvals.
- [Roles and permissions](./roles).

## You answer standups

- [User guide](./user-guide) — the daily card, skipping, blockers, DM commands,
  your own page.

## You integrate

- [Configuration](./configuration) — environment variables, settings,
  endpoints, webhooks.
- [JSON API](./api) — with the OpenAPI document.
- [Claude Code and MCP](./mcp).
- [Deployment reference](./deployment) — images, sizing, databases, bare Bun.

## Webhooks {#webhooks-ref}

Moved to [Configuration → Outbound webhooks](./configuration#outbound-webhooks).
