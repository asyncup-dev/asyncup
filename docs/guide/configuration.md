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

## Data

All state — standups, participants, admins, runs, submissions, blockers, app
settings — lives either in a single SQLite file (`DB_PATH`, the default) or in
your own PostgreSQL (`DATABASE_URL`). Back up the file or use your database's
backup story; stored secrets are encrypted, so backups are safe to ship
off-box as long as `SECRET_KEY` stays out of them. Schema migrations run
automatically on startup in both modes, so upgrading AsyncUp is just
deploying the new image. Graceful shutdown on SIGTERM included.
