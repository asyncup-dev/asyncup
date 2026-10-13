# Configuration

AsyncUp is configured in two layers:

1. **Bootstrap**: a handful of environment variables (database, port, the
   operator token, the encryption key). Set once, rarely touched. This page is
   the one reference for them.
2. **Everything else**: managed in the [web app](./web-app) under **Settings**
   and stored in your database, secrets encrypted (AES-256-GCM via
   `SECRET_KEY`). Changes apply immediately, no restart.

## Environment variables {#env-vars}

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Webhook, API and web app port |
| `DB_PATH` | `./data/standup.db` | SQLite database file (default storage). The image sets `/data/standup.db` in Compose |
| `DATABASE_URL` | *(empty)* | Bring-your-own PostgreSQL — when set, SQLite is skipped (see [Deployment reference](./deployment#database-embedded-or-bring-your-own)) |
| `DB_SSL` | from URL `sslmode` | Postgres TLS: `require` (encrypt, no verify — default for managed DBs), `verify-full`, or `disable` |
| `DB_SSL_CA` | *(empty)* | CA bundle path for `DB_SSL=verify-full` |
| `OPERATOR_TOKEN` | *(empty)* | Operator token for the web app and the JSON API — the way in before Google or SAML sign-in works, and break-glass after. Disabled while empty. `DASHBOARD_TOKEN` is the older name and still works; when both are set, `OPERATOR_TOKEN` wins, and a blank `OPERATOR_TOKEN=` falls back to `DASHBOARD_TOKEN` |
| `SECRET_KEY` | — | Encrypts stored secrets; signs sessions and webhooks. Generate with `openssl rand -hex 32`. Required (except `ADAPTER=fake`). Back it up separately from the database |
| `ADAPTER` | `google` | `google` for production, `fake` for a console demo |
| `TENANT_ID` | `default` | Tenant identifier — leave as is for self-hosted installs |

Changing a variable needs the container recreated, not just restarted:
`docker compose up -d --force-recreate asyncup`.

## App settings (stored in the database)

Open `https://HOST/app` → **Settings**. Each value saves on its own. Secrets
are write-only: the UI shows *that* they're set (and, for the service account,
its email), never the value.

| Where | Setting | What it does |
| --- | --- | --- |
| General | Default timezone for new standups | Assigned to new standups; people can set their own |
| General | Calendar out-of-office | Mark people away on OOO days. Needs [domain-wide delegation](./directory#calendar-ooo) |
| Google Chat | Project number (and the events URL) | The audience incoming events are verified against. For an add-on Chat app both are needed — [the audience rule](./google-chat-setup#the-audience-rule) |
| Google Chat | Service account | The JSON key used for Chat API calls, group rosters, Directory lookups and Calendar. Empty = [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials) for Chat only |
| Google Chat | Directory & Calendar access | Optional *Workspace admin to act as*: switches Directory lookups to domain-wide delegation. Not needed with the [admin role](./directory#admin-role); shows the *Delegation client ID* |
| Sign-in & SSO | Google sign-in | OAuth client ID and secret — [Google sign-in](./enterprise-sso#google-sign-in) |
| Sign-in & SSO | SAML single sign-on | IdP entity ID, SSO URL, certificate, admin attribute (default `groups`) and admin group (default `asyncup-admins`) — [SAML](./enterprise-sso#saml-sign-in) |
| Sign-in & SSO | Setup token | Whether the operator token still signs in. Can only be switched off while Google or SAML works |
| MCP server | Server, default scopes, access tokens | [Claude Code and MCP](./mcp) |
| API & tokens | Machine tokens | Tick (`POST /tick`), CSV export (`GET /export`) and SCIM (`/scim/v2`) tokens, each shown once |
| Danger zone | Disconnect Google Chat; Delete all standup history | Both behind a typed confirmation |

Per-standup settings (schedule, questions, mood, people, roster group,
escalation, webhook, digest, archive and delete) live on each standup's
**Settings** tab and in the [chat commands](./commands).

## Endpoints

All token comparisons are constant-time. ✱ = covered by the shared rate limiter
(60 requests a minute per IP).

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | Liveness: pings the database |
| `GET /health/chat` | none | Chat connection state without secrets: audience and key set, last verified or refused event |
| `POST /chat/events` | Google-signed JWT, verified against the audience | Google Chat events — point the Chat app here. Refuses everything until the audience is set |
| `POST /tick` ✱ | Bearer tick token (open until one exists) | Advance the scheduler from an external cron (scale-to-zero) |
| `GET /export?standupId=N&days=D` ✱ | Bearer export token (404 until one exists) | CSV, `D` clamped to 1–365 |
| `GET /app[/…]` | Session cookie, or the operator token entered on the sign-in page | The [web app](./web-app), including the guided setup at `/app/setup` and the personal page at `/app/me` |
| `/api/v1/…` (300 requests a minute) | Session cookie, or bearer operator token; `auth/methods` and `openapi.json` are public | The [JSON API](./api); OpenAPI 3.1 at `GET /api/v1/openapi.json` |
| `/mcp` ✱ | Bearer MCP token (503 while switched off; browser `Origin` refused) | [Model Context Protocol](./mcp) for Claude Code and other assistants |
| `GET /auth/google`, `GET /auth/callback`, `POST /auth/logout` ✱ | OAuth state nonce | Google sign-in |
| `GET /auth/saml`, `POST /auth/saml/acs`, `GET /auth/saml/metadata` ✱ | Signed assertions | SAML sign-in and SP metadata (404 until the IdP is configured) |
| `/scim/v2/ServiceProviderConfig`, `/scim/v2/Users[…]` ✱ | Bearer SCIM token (404 until one exists) | [SCIM 2.0](./enterprise-sso#scim-provisioning) |

## Outbound webhooks

Give a standup a **Webhook URL** (Standup › Settings › Integrations) and AsyncUp
POSTs JSON to it as things happen — the cheap path into Sheets (Apps Script),
Zapier/n8n, or your own service:

| Event | When | Body |
| --- | --- | --- |
| `submission` | Every submission and edit | `standup`, `date`, `user`, `answers`, `mood`, `late`, `edited` |
| `wrap_up` | The run closes | `standup`, `date`, `summary` (same numbers as the posted wrap-up) |
| `schedule_change` | Someone's week or days off change | person, summary, who, channel — see [Personal schedules](./schedules#integrations) |
| `time_off_request` | A request needs approval | person, dates, working, reason, request ids |
| `test` | **Send test** in the standup's settings | `standup` |

Deliveries time out after 5 s and failures are only logged — a dead webhook
never breaks the standup.

Every delivery is signed: the `X-AsyncUp-Signature` header carries
`sha256=<hex>`, the HMAC-SHA256 of the raw request body with the standup's
signing secret. The secret is derived from `SECRET_KEY` and the standup's id,
so rotating `SECRET_KEY` rotates it. Compute it on the server that holds the
key (standup id 3 here):

```bash
printf 'webhook:3' | openssl dgst -sha256 -hmac "$SECRET_KEY" | awk '{print $NF}'
```

Verify it in your receiver and reject anything that doesn't match:

```js
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
```

## Data

All state — standups, participants, admins, runs, submissions, blockers, app
settings — lives either in a single SQLite file (`DB_PATH`, the default) or in
your own PostgreSQL (`DATABASE_URL`). Schema migrations run automatically on
startup in both modes. Backups and upgrades: [Operations](./operations).

> **Managed Postgres TLS:** RDS / Cloud SQL / Neon / Supabase present a
> certificate signed by their own CA. AsyncUp treats `sslmode=require` as
> "encrypt but don't verify the cert" (the libpq default every other client
> uses), so `DATABASE_URL=…?sslmode=require` connects out of the box. For
> strict verification set `DB_SSL=verify-full` and point `DB_SSL_CA` at the
> provider's CA bundle.

Stored secrets are encrypted, so backups are safe to ship off-box as long as
`SECRET_KEY` stays out of them. Graceful shutdown on SIGTERM included.
