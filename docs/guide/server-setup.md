# Setup guide — every scenario

From a 5-person team on a $5 box to a locked-down production deployment.
Pick your path with the matrix, follow the walkthrough, finish with the
production checklist.

## Which setup should I pick?

| Your situation | Recommended path | Database | ~Cost/mo |
| --- | --- | --- | --- |
| Small team (≤25), want the simplest thing that works | **[Path A — VPS + SQLite](#path-a)** | embedded SQLite | $4–6 |
| You already run (or want) real Postgres ops | **[Path B — VPS + PostgreSQL](#path-b)** | bundled or managed | $4–20 |
| No server to maintain, ever | **[Path C — Cloud Run](#path-c)** | managed Postgres | ~$0–10 |
| Homelab / Raspberry Pi / behind NAT | **[Path D — home server + tunnel](#path-d)** | embedded SQLite | $0 + power |
| Company platform (K8s, ECS, …) | your platform + **[production checklist](#production-checklist)** | managed Postgres | varies |

### Real numbers, so you can stop worrying about scale

A **10-person team** posting daily generates roughly:

- ~10 form submissions + ~40 webhook calls per workday — *seconds* of CPU
- ~2,600 submissions/year ≈ **2–3 MB** of database growth
- Peak memory ~150 MB RSS regardless of team size

A **100-person org** across 10 standups is still ~25 MB/year and idles the
same. **Performance never decides this choice** — every path above handles
hundreds of users on minimum hardware. Choose by *operations*:

- **SQLite** = one file. Backup is `cp`, restore is `cp`. Perfect until you
  need point-in-time recovery or someone else managing durability.
- **Managed Postgres** = automated backups, PITR, failover — someone else's
  pager. Worth it when losing a week of standups would actually hurt, or
  when company policy says "no databases on VMs".
- **Bundled Postgres on the same box** is mostly a stepping stone: you get
  Postgres semantics but still own backups. Prefer SQLite (simpler) or
  managed (safer) unless you specifically want it.

**So: 10 people putting daily updates?** Path A. Genuinely. Move to managed
Postgres when the standup history becomes something you'd be sad to lose —
it's a one-line `DATABASE_URL` change and the schema recreates itself.

---

## Path A — VPS + SQLite (the default) {#path-a}

Everything from "I have nothing" to AsyncUp on your own domain with
automatic HTTPS. No prior server experience assumed — about 30 minutes.

```
your team's Google Chat ⇄ https://standup.example.com
                              │  Caddy (automatic HTTPS)
                              ▼
                          AsyncUp container (SQLite inside)
```

### A1. Rent a small server

Any provider — Hetzner, DigitalOcean, Vultr, Lightsail, OVH, Oracle Cloud's
free tier…

- **1 vCPU, 512 MB+ RAM**, 10 GB disk — usually the cheapest tier
- **Ubuntu 24.04 LTS** (commands assume it; Debian is identical)
- amd64 or arm64 — both images are published

You'll get an **IP address** and SSH access (`ssh root@<ip>`).

### A2. Point a domain at it

Create an **A record** for a subdomain pointing at the server's IP:

| Type | Name | Value |
| --- | --- | --- |
| A | `standup` | `<your server IP>` |

`ping standup.example.com` should answer from your server before you
continue — HTTPS certificates won't issue until DNS resolves.

### A3. Basic hardening + Docker

```bash
apt-get update && apt-get -y upgrade && apt-get -y install unattended-upgrades ufw

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

curl -fsSL https://get.docker.com | sh
```

### A4. Deploy AsyncUp + Caddy

Caddy obtains and renews **Let's Encrypt certificates automatically** — you
never touch TLS. Three files in `/opt/asyncup`:

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

AsyncUp itself exposes no ports to the internet — only Caddy does.

**`Caddyfile`** (swap in your domain)

```
standup.example.com {
    reverse_proxy asyncup:8080
}
```

**`.env`** — two generated secrets:

```
DASHBOARD_TOKEN=<openssl rand -hex 24>
SECRET_KEY=<openssl rand -hex 32>
```

Start and verify:

```bash
docker compose up -d
curl https://standup.example.com/healthz     # → {"ok":true}
```

The first HTTPS request can take ~30s while the certificate issues. If it
doesn't: `docker compose logs caddy` — usual culprits are DNS not pointing
here yet, or a *provider-level* firewall blocking 80/443 in addition to ufw.

Open **`https://standup.example.com/dashboard?token=<DASHBOARD_TOKEN>`**,
follow the first-run checklist, then [Google Chat setup](./google-chat-setup).

### A5. Updates & backups

```bash
# update (schema migrates automatically)
cd /opt/asyncup && docker compose pull && docker compose up -d

# nightly backup (cron): one file is the whole database
docker compose cp asyncup:/data/standup.db ./standup-backup-$(date +%F).db
```

Stored secrets are encrypted — keep `SECRET_KEY` (your `.env`) backed up
*separately* from database backups. Restore = put the file back, `up -d`.

---

## Path B — VPS + PostgreSQL {#path-b}

Same as Path A, with the database swapped. Two flavors:

### B1. Managed Postgres (recommended for production)

Create a database on RDS, Cloud SQL, Neon, Supabase, DigitalOcean — anything
that speaks Postgres. Then add one line to `.env`:

```
DATABASE_URL=postgres://user:password@host:5432/asyncup
```

`docker compose up -d` — the schema creates and migrates itself. SQLite is
skipped entirely. You inherit the provider's backups, PITR, and failover.
If the provider requires TLS, append `?sslmode=require` to the URL.

### B2. Bundled Postgres on the same machine

Use the repo's compose file, which ships an optional Postgres 18 service:

```bash
git clone https://github.com/asyncup-dev/asyncup /opt/asyncup && cd /opt/asyncup
cp .env.example .env    # set DASHBOARD_TOKEN, SECRET_KEY, POSTGRES_PASSWORD
# and: DATABASE_URL=postgres://asyncup:<password>@postgres:5432/asyncup
docker compose --profile postgres up -d
```

(Add the Caddy service from Path A for HTTPS.) Sizing: 2 GB RAM is
comfortable for app + Postgres. Backups become your job:

```bash
docker compose exec postgres pg_dump -U asyncup asyncup | gzip > backup-$(date +%F).sql.gz
```

---

## Path C — Cloud Run, no server at all {#path-c}

Closest to zero ops and realistically ~$0–10/month: the container scales to
zero between standups.

1. **Database: use managed Postgres** (Cloud SQL, or Neon's free tier).
   Don't put SQLite on Cloud Run — its filesystem is ephemeral and
   network-mounted volumes don't support SQLite's locking properly.
2. Deploy `ghcr.io/asyncup-dev/asyncup:latest` to **Cloud Run**:
   min instances 0, **max instances 1** (important — see the
   [checklist](#production-checklist)), port 8080, env vars:
   `DATABASE_URL`, `DASHBOARD_TOKEN`, `SECRET_KEY`.
3. The in-process scheduler only runs while an instance is alive, so drive
   it externally: a **Cloud Scheduler** job (free tier covers it) hitting
   `POST https://<your-run-url>/tick` every minute with header
   `Authorization: Bearer <tick token>` (generate the token in dashboard →
   Settings → Access tokens).
4. Cloud Run gives you HTTPS out of the box; map a custom domain in its
   settings if you want one.
5. Bonus: skip the service-account key entirely — give the Cloud Run service
   account Chat API access and leave the key field empty (ADC).

Webhook events wake the instance on demand; `/tick` wakes it for prompts,
reminders, and deadlines. Ticks are idempotent — missed or overlapping ticks
are safe.

---

## Path D — home server / Raspberry Pi behind NAT {#path-d}

No public IP needed: a **Cloudflare Tunnel** makes an outbound-only
connection and gives your domain HTTPS for free.

1. Domain on Cloudflare (free plan) → Zero Trust → Tunnels → create a tunnel,
   route `standup.example.com` → `http://asyncup:8080`.
2. On the Pi/box (arm64 and amd64 both work):

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

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}

volumes:
  standup-data:
```

No open ports, no port forwarding, no certificates to manage. Everything
else (env, dashboard, backups) is identical to Path A.

---

## Production checklist {#production-checklist}

Whatever path you chose:

- [ ] **Exactly one instance.** The scheduler runs in-process — two replicas
      would double-send prompts. On K8s: `replicas: 1` + `Recreate` strategy;
      on Cloud Run: max instances 1. (HA isn't needed — a restart loses
      nothing, and ticks catch up.)
- [ ] HTTPS in front of `/chat/events`; GCP **project number** set in
      dashboard settings so webhooks are cryptographically verified
- [ ] `DASHBOARD_TOKEN` + `SECRET_KEY` set; `SECRET_KEY` backed up somewhere
      that is *not* the database backup
- [ ] Tick token generated if `/tick` is internet-reachable
- [ ] Backups: nightly SQLite file copy *or* managed-Postgres automated
      backups; do one restore drill
- [ ] Monitoring: point any uptime monitor at `GET /healthz` (it pings the
      database); alert on non-200
- [ ] Updates: `docker compose pull && up -d` periodically — or pin a digest
      and bump deliberately; watch the repo's releases
- [ ] Logs: `docker compose logs` is plain stdout — ship it wherever your
      logs go, or rely on `docker logs` retention

## Quick reference

| | Path A (VPS+SQLite) | Path B1 (managed PG) | Path C (Cloud Run) | Path D (home) |
| --- | --- | --- | --- | --- |
| Monthly cost | $4–6 | $4–6 + DB ($0–15) | ~$0–10 | $0 |
| Ops you own | VM updates, file backup | VM updates | none | the hardware |
| Backups | one file, cron | provider PITR | provider PITR | one file, cron |
| TLS | Caddy, automatic | Caddy, automatic | built-in | Cloudflare, automatic |
| Best for | ≤50 people, simplicity | history you can't lose | zero maintenance | tinkerers |
