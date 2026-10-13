# 7. Operations

Step 7 of the [setup path](./getting-started): keeping an install healthy.
The commands assume [Path A](./server-setup#path-a): Docker Compose in
`/opt/asyncup`, SQLite in the `standup-data` volume. Compose prefixes volume
names with the project, so on disk it is `asyncup_standup-data`; check with
`docker volume ls`.

## Health checks

| Check | Proves |
| --- | --- |
| `GET https://HOST/healthz` → `{"ok":true}` | The app answered and reached its database |
| `GET https://HOST/health/chat` | The audience and service-account key are set, and when the last signed Chat event arrived (`lastEventAt`) or was refused (`lastRejectedAt`). No secrets |
| `GET https://HOST/api/v1/me` with `Authorization: Bearer <operator token>` → `"kind":"admin"` | The API and authentication work end to end (while token sign-in is on) |

A `200` from `https://HOST/` or `/app` is not enough: that is a static page and
can load while the backend is down. Point uptime monitoring at `/healthz` and
alert on anything but `200`.

## Upgrade {#upgrade}

Images are published to `ghcr.io/asyncup-dev/asyncup` on every merge to
`main`, tagged `latest` and `sha-<short commit>` (the first seven characters of
the commit). Each also carries the full commit in its
`org.opencontainers.image.revision` label. Database migrations run on startup
and only go forward, so take a backup before every upgrade.

```bash
cd /opt/asyncup

# 1. Note what is running now, for a rollback
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$(docker compose ps -q asyncup)"

# 2. Pull, and check you got the build you expect
docker compose pull asyncup
docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  ghcr.io/asyncup-dev/asyncup:latest

# 3. Stop the app and back up the database volume
docker compose stop asyncup
BACKUP=/root/asyncup-backup-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -m 700 "$BACKUP"
cp -a "$(docker volume inspect --format '{{.Mountpoint}}' asyncup_standup-data)"/. "$BACKUP/"
echo "backup at $BACKUP"

# 4. Start the new image and check it
docker compose up -d asyncup
docker compose logs --since 2m asyncup | grep 'listening on'
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}} restarts={{.RestartCount}}' \
  "$(docker compose ps -q asyncup)"
curl -fsS https://HOST/healthz
```

Write down the revision from step 1 and the backup path from step 3. Then run
the [health checks](#health-checks) above. Copying the volume while the app is
stopped catches the SQLite write-ahead log with it, so the backup is
consistent. The app is down for a few seconds, and anyone who clicks a card in
that moment sees "not responding", so upgrade outside standup hours.

To pin versions instead of following `latest`, use a `sha-<short commit>` tag
or a digest in `compose.yml`, and change it deliberately.

### Roll back

Migrations don't run backwards, so rolling back means restoring the backup
taken before the upgrade, with the image you ran before:

1. In `compose.yml`, set `image: ghcr.io/asyncup-dev/asyncup:sha-<first 7
   characters of the revision from step 1>`.
2. [Restore](#restore) the backup from step 3.

## Restore {#restore}

Use the literal path of the backup you want, not a shell variable left over
from another session, and don't go on unless the check prints *found*.

From a stopped-volume backup (a folder holding `standup.db` and, possibly,
`standup.db-wal` and `standup.db-shm`):

```bash
cd /opt/asyncup
B=/root/asyncup-backup-20260101T090000Z          # the backup to restore
test -d "$B" && test -f "$B/standup.db" && echo "backup found" || echo "NO BACKUP AT $B - stop here"
docker compose stop asyncup
VOL="$(docker volume inspect --format '{{.Mountpoint}}' asyncup_standup-data)"
rm -f "$VOL"/standup.db "$VOL"/standup.db-wal "$VOL"/standup.db-shm
cp -a "$B"/. "$VOL"/
docker compose up -d asyncup
```

From a nightly snapshot (a single `.db` file):

```bash
cd /opt/asyncup
F=/opt/asyncup/standup-2026-01-01.db             # the snapshot to restore
test -f "$F" && echo "snapshot found" || echo "NO SNAPSHOT AT $F - stop here"
docker compose stop asyncup
VOL="$(docker volume inspect --format '{{.Mountpoint}}' asyncup_standup-data)"
rm -f "$VOL"/standup.db-wal "$VOL"/standup.db-shm
cp "$F" "$VOL"/standup.db
docker compose up -d asyncup
```

Deleting the `-wal` and `-shm` files matters: left behind, SQLite would try to
apply them to the restored file. Then run the [health checks](#health-checks).

For PostgreSQL, restore with your provider's tools, or for the bundled service
`gunzip -c backup.sql.gz | docker compose exec -T postgres psql -U asyncup asyncup`
into an empty database.

## Backups {#backups}

Everything lives in the database: standups, rosters, runs, answers, blockers and
settings. Stored secrets are encrypted with `SECRET_KEY`, so keep `SECRET_KEY`
(your `.env`) backed up **separately** from the database. A database restored
without the matching `SECRET_KEY` can't decrypt the service-account key, OAuth
and SAML secrets stored in it.

| Kind | How |
| --- | --- |
| Before an upgrade | The stopped-volume copy above |
| Nightly, no downtime | SQLite's `VACUUM INTO` writes a consistent copy of the live database |
| Managed PostgreSQL | The provider's automated backups and point-in-time recovery |
| Bundled PostgreSQL | `docker compose exec postgres pg_dump -U asyncup asyncup \| gzip > backup-$(date +%F).sql.gz` |

The nightly SQLite snapshot, for cron (`VACUUM INTO` refuses to overwrite, so
clear any leftover first):

```bash
cd /opt/asyncup
docker compose exec -T asyncup rm -f /data/snapshot.db
docker compose exec -T asyncup bun -e \
  "import {Database} from 'bun:sqlite'; new Database('/data/standup.db').run(\"VACUUM INTO '/data/snapshot.db'\")"
docker compose cp asyncup:/data/snapshot.db ./standup-$(date +%F).db
docker compose exec -T asyncup rm -f /data/snapshot.db
```

Don't copy `standup.db` out of a running container: without its write-ahead
log the copy can miss recent writes.

Old backups are yours to prune. Do one restore drill: restore a backup into a
scratch volume and start a second container against it on another port.

## Rotate the operator token

1. Generate a new one: `openssl rand -hex 24`.
2. Put it in `/opt/asyncup/.env` as `OPERATOR_TOKEN=…`.
3. Recreate the container so it reads the new value:
   `docker compose up -d --force-recreate asyncup`. A plain `restart` keeps the
   old environment.

The old token stops working at once. If `.env` has both `OPERATOR_TOKEN` and
the older `DASHBOARD_TOKEN`, `OPERATOR_TOKEN` wins; a blank `OPERATOR_TOKEN=`
line falls back to `DASHBOARD_TOKEN`.

Don't rotate `SECRET_KEY` casually: it decrypts every stored secret and signs
sessions and webhooks. Changing it signs everyone out, changes each standup's
webhook signing secret, and means pasting the stored secrets again.

## Locked out {#locked-out}

If token sign-in is switched off and Google and SAML sign-in both stop working,
switch token sign-in back on in the database, then restart:

```bash
cd /opt/asyncup
docker compose exec -T asyncup bun -e \
  "import {Database} from 'bun:sqlite'; new Database('/data/standup.db').run(\"DELETE FROM settings WHERE key = 'tokenSignIn'\")"
docker compose restart asyncup
```

For the bundled PostgreSQL:
`docker compose exec postgres psql -U asyncup asyncup -c "DELETE FROM settings WHERE key = 'tokenSignIn';"`,
then `docker compose restart asyncup`. For managed PostgreSQL, run the same
`DELETE` with `psql` against `DATABASE_URL`. Then sign in with the operator token
and fix the broken method.

## Logs

`docker compose logs asyncup` is plain stdout. Every Chat event is logged with
its type and format, every refused event with the reason, and the scheduler
logs each run opening and closing and each roster sync. Ship it wherever your
logs go.

## Exactly one instance

The scheduler runs inside the app. Two copies would send every prompt twice.
On Kubernetes use `replicas: 1` with the `Recreate` strategy; on Cloud Run, max
instances 1. A restart loses nothing: ticks catch up.
