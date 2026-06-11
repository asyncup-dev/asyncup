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
| `EXPORT_TOKEN` | *(empty)* | Shared secret for `GET /export`. **Endpoint disabled while empty** |
| `LLM_PROVIDER` | *(empty)* | `anthropic` or `openai` — enables [AI summaries](./ai) |
| `LLM_API_KEY` | — | Your LLM provider API key |
| `LLM_MODEL` | `claude-opus-4-7` (anthropic) | Model override; required for openai |

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /chat/events` | Google Chat webhook — point the Chat app here |
| `POST /tick` | Manually advance the scheduler (for external cron). Requires `Authorization: Bearer $TICK_TOKEN` when set |
| `GET /export?standupId=N&days=30` | CSV download of submissions (long format: one row per answer). Requires `Authorization: Bearer $EXPORT_TOKEN`; disabled when unset |
| `GET /healthz` | Liveness check |

## Data

All state lives in a single SQLite file (`DB_PATH`): standups, participants,
admins, runs, submissions, blockers, and the DM-space cache. Back it up like
any file; the process can restart at any time without losing or double-sending
prompts. Schema migrations run automatically on startup (tracked via
`PRAGMA user_version`), so upgrading AsyncUp is just deploying the new image.
