# Configuration

AsyncUp is configured in two layers:

1. **Bootstrap** — a handful of environment variables (where's the database,
   what port, the dashboard token). Set once, rarely touched.
2. **Everything else** — managed in the **[web dashboard](./dashboard)
   Settings page** and stored in your database, with secrets encrypted
   (AES-256-GCM via `SECRET_KEY`). Changes apply immediately, no restart.

## Bootstrap environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Webhook + dashboard port |
| `DB_PATH` | `./data/standup.db` | SQLite database file (default storage) |
| `DATABASE_URL` | *(empty)* | Bring-your-own PostgreSQL — when set, SQLite is skipped (see [Deployment](./deployment#database-embedded-or-bring-your-own)) |
| `DB_SSL` | from URL `sslmode` | Postgres TLS: `require` (encrypt, no verify — default for managed DBs), `verify-full`, or `disable` |
| `DB_SSL_CA` | *(empty)* | CA bundle path for `DB_SSL=verify-full` |
| `DASHBOARD_TOKEN` | *(empty)* | Secret for `/dashboard` — **required** to configure the app. Disabled while empty |
| `SECRET_KEY` | — | Encrypts stored secrets. Generate with `openssl rand -hex 32`. Required (except `ADAPTER=fake`) |
| `ADAPTER` | `google` | `google` for production, `fake` for a console demo |
| `TENANT_ID` | `default` | Tenant identifier — leave as is for self-hosted installs |

## Dashboard settings (stored in the database)

Open `https://<your-host>/dashboard?token=<DASHBOARD_TOKEN>` → **Settings**:

| Setting | What it does |
| --- | --- |
| GCP project number | Verifies incoming webhooks are signed by Google Chat |
| Service-account key (JSON) | Paste the downloaded key file — used for Chat API calls and Calendar OOO. Empty = [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials) (e.g. Cloud Run service identity) |
| AI provider / API key / model | Bring-your-own-key [AI summaries](./ai) |
| Default timezone | Assigned to newly created standups |
| Calendar OOO sync | Auto-mark people away on out-of-office days |
| Workspace admin email | Enables Directory API lookups (email + admin status by Chat user id). With it, Calendar OOO covers people who never interacted with the bot |
| OAuth client ID / secret | Enables [Sign in with Google](./dashboard#sign-in-with-google--admin-and-user-consoles): Workspace admins get the admin console, everyone else the `/me` user console |
| SAML IdP entity / SSO URL / cert | Enables [SAML sign-in](./enterprise-sso) with any IdP; admin via IdP group and/or Google Directory |
| SCIM provisioning token | Enables the [SCIM 2.0 endpoint](./enterprise-sso#scim-provisioning) at `/scim/v2` for Okta/Entra/OneLogin |
| Scheduler tick token | Authorizes `POST /tick` for external cron |
| CSV export token | Enables `GET /export` (off until generated) |

Secrets are write-only: the UI shows *that* they're configured (and e.g. the
service account's email), never the material itself.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /chat/events` | Google Chat webhook — point the Chat app here |
| `POST /tick` | Manually advance the scheduler (for external cron). Requires `Authorization: Bearer <tick token>` when one is set |
| `GET /export?standupId=N&days=30` | CSV download (long format). Requires the export token; disabled until one is generated |
| `GET /dashboard` | [Web dashboard](./dashboard) — settings, config, history |
| `GET /healthz` | Liveness check (pings the database) |

## Outbound webhooks

Give a standup a **Webhook URL** (dashboard → standup page) and AsyncUp POSTs
JSON to it as things happen — the cheap path into Sheets (Apps Script),
Zapier/n8n, or your own service:

- `{"event": "submission", "standup": {…}, "date", "user", "answers", "mood",
  "late", "edited"}` — on every submission and edit.
- `{"event": "wrap_up", "standup": {…}, "date", "summary": {…}}` — when the
  run closes (same numbers as the posted wrap-up).

Deliveries time out after 5 s and failures are only logged — a dead webhook
never breaks the standup.

Every delivery is signed: the `X-AsyncUp-Signature` header carries
`sha256=<hex>`, the HMAC-SHA256 of the raw request body with the standup's
signing secret. The secret is shown on the standup's dashboard page (derived
from `SECRET_KEY`, so rotating `SECRET_KEY` rotates it). Verify it in your
receiver and reject anything that doesn't match:

```js
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
```

## Data

All state — standups, participants, admins, runs, submissions, blockers, app
settings — lives either in a single SQLite file (`DB_PATH`, the default) or in
your own PostgreSQL (`DATABASE_URL`).

> **Managed Postgres TLS:** RDS / Cloud SQL / Neon / Supabase present a
> certificate signed by their own CA. AsyncUp treats `sslmode=require` as
> "encrypt but don't verify the cert" (the libpq default every other client
> uses), so `DATABASE_URL=…?sslmode=require` connects out of the box. For
> strict verification set `DB_SSL=verify-full` and point `DB_SSL_CA` at the
> provider's CA bundle. (Earlier builds inherited node-pg's stricter default
> and crash-looped with `SELF_SIGNED_CERT_IN_CHAIN` — that's fixed.)

Back up the file or use your database's
backup story; stored secrets are encrypted, so backups are safe to ship
off-box as long as `SECRET_KEY` stays out of them. Schema migrations run
automatically on startup in both modes, so upgrading AsyncUp is just
deploying the new image. Graceful shutdown on SIGTERM included.
