# Deployment

AsyncUp is one small container — by default with SQLite inside, so there are
no external moving parts at all. Google Chat needs to reach it on a public
HTTPS URL.

## Database: embedded or bring your own

| Mode | Configuration | When to choose it |
| --- | --- | --- |
| **Embedded SQLite** (default) | `DB_PATH` on a persistent volume | Simplest possible ops: one container, one file to back up. Plenty for any team size AsyncUp serves |
| **Bring your own PostgreSQL** | `DATABASE_URL=postgres://…` | You already run managed Postgres (RDS, Cloud SQL, Neon, Supabase, …) and want its backups/HA, or your platform has no persistent volumes (e.g. some scale-to-zero setups) |
| **Postgres on the same machine** | `docker compose --profile postgres up -d` + `DATABASE_URL=postgres://asyncup:…@postgres:5432/asyncup` | Postgres semantics without leaving the box |

Setting `DATABASE_URL` skips SQLite entirely; the schema is created and
migrated automatically on startup in both modes. The full test suite runs
against both engines in CI on every change.

## System requirements

AsyncUp idles at a once-a-minute scheduler tick; load is a few webhook calls
per person per day. CPU architecture: amd64 or arm64.

| Setup | Minimum | Recommended |
| --- | --- | --- |
| App + SQLite | 1 vCPU (shared is fine), 256 MB RAM, 1 GB disk | 1 vCPU, **512 MB RAM**, 5 GB disk |
| App + bundled Postgres | 1 vCPU, 768 MB RAM, 3 GB disk | **2 vCPU, 2 GB RAM**, 10 GB disk |
| App with external/managed DB | 1 vCPU, 256 MB RAM | 1 vCPU, 512 MB RAM |

Realistic sizing: the Node process uses ~100–150 MB RSS; the image is ~300 MB;
a year of standups for a 50-person team is well under 100 MB of data. The
smallest VPS tier (or Cloud Run's 512 MB default) is comfortably enough —
teams into the hundreds of users don't change this picture.

## Prebuilt image

Multi-arch images (`linux/amd64`, `linux/arm64`) are published to GHCR on
every merge to `main`:

```bash
docker pull ghcr.io/asyncup-dev/asyncup:latest
```

Tags: `latest` (main), `vX.Y.Z` + `X.Y` (releases), `sha-…` (every build) —
pin a digest for reproducible deploys. Building from source stays a
one-liner (`docker build -t asyncup .`) if you prefer auditing what you run.

## Docker Compose (simplest)

```bash
cp .env.example .env       # set DASHBOARD_TOKEN + SECRET_KEY
docker compose up -d       # pulls the GHCR image by default
# then finish setup in https://<host>/dashboard?token=<DASHBOARD_TOKEN>
```

Put it behind any HTTPS reverse proxy (Caddy, nginx, Traefik) and point the
Chat app at `https://<your-host>/chat/events`. The SQLite data lives in the
`standup-data` volume.

A 1-shared-CPU VPS or a free-tier VM is plenty — the bot is idle except for
a once-a-minute scheduler tick and your team's submissions.

## Scale-to-zero (Cloud Run) {#scale-to-zero-cloud-run}

Closest thing to "no servers at all", and realistically $0/month at team
scale on the free tier:

1. Deploy the container to **Cloud Run** (min instances = 0). Mount a
   [Cloud Run volume](https://cloud.google.com/run/docs/configuring/services/volume-mounts)
   or persistent disk for `DB_PATH` so SQLite survives restarts.
2. The in-process scheduler only runs while an instance is alive, so drive
   it externally: create a **Cloud Scheduler** job (free tier: 3 jobs) that
   hits `POST /tick` every minute with header
   `Authorization: Bearer <tick token>`.
3. Generate the tick token in dashboard → Settings → Access tokens.

Webhook events (dialog opens, submissions, commands) spin the instance up
on demand; `/tick` wakes it for prompts, reminders, and deadlines. Ticks are
idempotent — overlapping or missed ticks are safe and caught up on the next
one.

## Bare Node

```bash
npm ci && npm run build
PORT=8080 DB_PATH=/var/lib/asyncup/standup.db node dist/index.js
```

Run it under systemd or any process manager.

## Production checklist

- [ ] GCP project number set in dashboard settings (request verification on)
- [ ] HTTPS in front of `/chat/events`
- [ ] Tick token generated if `/tick` is internet-reachable; `SECRET_KEY` backed up
- [ ] `DB_PATH` on persistent storage, backed up
