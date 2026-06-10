# Deployment

AsyncUp is one small container with SQLite inside — no external database, no
queue, no other moving parts. Google Chat needs to reach it on a public
HTTPS URL.

## Docker Compose (simplest)

```bash
cp .env.example .env       # set GOOGLE_CHAT_AUDIENCE, credentials path
# uncomment the service-account.json mount in docker-compose.yml
docker compose up -d
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
   `Authorization: Bearer <TICK_TOKEN>`.
3. Set `TICK_TOKEN` in the service env.

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

- [ ] `GOOGLE_CHAT_AUDIENCE` set (request verification on)
- [ ] HTTPS in front of `/chat/events`
- [ ] `TICK_TOKEN` set if `/tick` is internet-reachable
- [ ] `DB_PATH` on persistent storage, backed up
