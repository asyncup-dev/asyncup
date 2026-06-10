# Configuration

Everything is configured via environment variables (see `.env.example`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Webhook port |
| `DB_PATH` | `./data/standup.db` | SQLite database file |
| `ADAPTER` | `google` | `google` for production, `fake` for a console demo |
| `GOOGLE_CHAT_AUDIENCE` | *(empty)* | Your GCP project **number**. Verifies incoming requests are signed by Google Chat. Empty skips verification — local development only |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Path to the service account key JSON |
| `DEFAULT_TIMEZONE` | `UTC` | Timezone assigned to newly created standups |
| `TENANT_ID` | `default` | Tenant identifier — leave as is for self-hosted installs |
| `TICK_TOKEN` | *(empty)* | Shared secret for `POST /tick` (see [Deployment](./deployment#scale-to-zero-cloud-run)) |

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /chat/events` | Google Chat webhook — point the Chat app here |
| `POST /tick` | Manually advance the scheduler (for external cron). Requires `Authorization: Bearer $TICK_TOKEN` when set |
| `GET /healthz` | Liveness check |

## Data

All state lives in a single SQLite file (`DB_PATH`): standups, participants,
runs, submissions, and the DM-space cache. Back it up like any file; the
process can restart at any time without losing or double-sending prompts.
