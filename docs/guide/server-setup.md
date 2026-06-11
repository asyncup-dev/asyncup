# Server setup from zero

Everything from "I have nothing" to AsyncUp running on your own domain with
automatic HTTPS. No prior server experience assumed — about 30 minutes.

What you'll end up with:

```
your team's Google Chat ⇄ https://standup.example.com
                              │  Caddy (automatic HTTPS)
                              ▼
                          AsyncUp container (SQLite inside)
```

## 1. Rent a small server

Any provider works — Hetzner, DigitalOcean, Vultr, Lightsail, OVH, Oracle
Cloud's free tier… AsyncUp needs very little
(see [system requirements](./deployment#system-requirements)):

- **1 vCPU, 512 MB+ RAM**, 10 GB disk — usually the cheapest tier (~$4–6/mo)
- **Ubuntu 24.04 LTS** (commands below assume it; Debian works identically)
- amd64 or arm64 — both are published images

You'll get an **IP address** and SSH access (`ssh root@<ip>`).

## 2. Point a domain at it

In your DNS provider, create an **A record** for a subdomain pointing at the
server's IP:

| Type | Name | Value |
| --- | --- | --- |
| A | `standup` | `<your server IP>` |

So `standup.example.com → <ip>`. DNS usually propagates in minutes —
`ping standup.example.com` should answer from your server's IP before you
continue (HTTPS certificates won't issue until it does).

## 3. Basic hardening + Docker

SSH in and run:

```bash
# stay patched automatically
apt-get update && apt-get -y upgrade && apt-get -y install unattended-upgrades ufw

# firewall: SSH + web only
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Docker (official install script)
curl -fsSL https://get.docker.com | sh
```

## 4. Deploy AsyncUp + Caddy

Caddy is a tiny web server that gets and renews **Let's Encrypt certificates
automatically** — you never touch TLS again. Create a directory with three
files:

```bash
mkdir -p /opt/asyncup && cd /opt/asyncup
```

**`compose.yml`**

```yaml
services:
  asyncup:
    image: ghcr.io/asyncup-dev/asyncup:latest
    restart: unless-stopped
    env_file: .env
    environment:
      DB_PATH: /data/standup.db
    volumes:
      - standup-data:/data

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  standup-data:
  caddy-data:
  caddy-config:
```

Note that AsyncUp itself exposes no ports to the internet — only Caddy does.

**`Caddyfile`** (swap in your domain)

```
standup.example.com {
    reverse_proxy asyncup:8080
}
```

**`.env`**

```bash
DASHBOARD_TOKEN=$(openssl rand -hex 24)   # run these two commands and paste
SECRET_KEY=$(openssl rand -hex 32)        # the values, or use any generator
```

i.e. the file should contain two lines like:

```
DASHBOARD_TOKEN=2f8c1d…
SECRET_KEY=9b04ee…
```

Start it:

```bash
docker compose up -d
```

## 5. Verify

```bash
curl https://standup.example.com/healthz     # → {"ok":true}
```

First HTTPS request can take ~30 seconds while Caddy obtains the certificate.
If it doesn't come up: `docker compose logs caddy` — the usual culprits are
DNS not pointing at this server yet, or ports 80/443 blocked by a provider
firewall (some clouds have one *in addition to* ufw).

Now open **`https://standup.example.com/dashboard?token=<DASHBOARD_TOKEN>`** —
you'll see the first-run checklist. From here, follow
**[Google Chat setup](./google-chat-setup)** (paste your GCP project number
and service-account key into Settings, point the Chat app at
`https://standup.example.com/chat/events`).

## 6. Updates & backups

**Update AsyncUp** (new image, schema migrates automatically):

```bash
cd /opt/asyncup && docker compose pull && docker compose up -d
```

**Back up the database** (everything lives in one SQLite file):

```bash
docker compose cp asyncup:/data/standup.db ./standup-backup-$(date +%F).db
```

Drop that line in a cron job and ship the file wherever you keep backups.
Stored secrets in it are encrypted — just keep `SECRET_KEY` (your `.env`)
backed up separately. Restoring = putting the file back and
`docker compose up -d`.

**Logs:** `docker compose logs -f asyncup`

## Variations

- **Your own Postgres** instead of SQLite: add `DATABASE_URL=postgres://…` to
  `.env` — see [Deployment](./deployment#database-embedded-or-bring-your-own).
- **Existing reverse proxy** (nginx, Traefik, …): skip Caddy, expose
  `asyncup` on a local port and proxy `https://your-domain → localhost:8080`.
- **No server at all**: Cloud Run scale-to-zero —
  see [Deployment](./deployment#scale-to-zero-cloud-run).
