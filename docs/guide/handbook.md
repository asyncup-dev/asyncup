# The AsyncUp Handbook

Everything in one place, organised by who you are — following the
[Diátaxis](https://diataxis.fr/) split of *learning*, *doing*, and *looking
things up*:

- **[Part 1 — Setup](#part-1--setup-operators)**: you run the server.
- **[Part 2 — Admin guide](#part-2--admin-guide)**: you run the standups.
- **[Part 3 — User guide](#part-3--user-guide)**: you answer them.
- **[Part 4 — Reference](#part-4--reference)**: every command, endpoint and setting.

## What AsyncUp is

AsyncUp replaces the daily standup meeting with a Google Chat flow: every
workday each participant gets a DM card; one tap opens a form (three
questions plus an optional mood dropdown); answers post as cards under a
per-date thread in the team space; at the deadline a wrap-up posts the count
and exactly who's missing. Around that core: blocker tracking and
collaboration, polls, trends and charts, weekly digests, webhooks, optional
AI summaries, and web consoles with Google/SAML sign-in. It is MIT-licensed,
self-hosted, one container — **everything documented here is in the free
open-source core**.

---

## Part 1 — Setup (operators)

*You install and operate the server. Budget ~20 minutes plus your IdP's
paperwork if you enable sign-in.*

### 1.1 Deploy the container

```bash
git clone https://github.com/asyncup-dev/asyncup && cd asyncup
cp .env.example .env    # set DASHBOARD_TOKEN and SECRET_KEY (openssl rand -hex 32)
docker compose up -d    # ghcr.io/asyncup-dev/asyncup, amd64 + arm64
```

Embedded SQLite is the default; set `DATABASE_URL` for your own PostgreSQL.
Expose the port over HTTPS (Caddy, a tunnel, Cloud Run — see the
[server setup guide](./server-setup) for four complete paths). All
[bootstrap environment variables](#env-vars) are in the reference below;
everything else is configured in the dashboard and stored encrypted in the
database.

### 1.2 Connect Google Chat

Follow the [Google Chat setup guide](./google-chat-setup): create a GCP
project, enable the Chat API, create a service account, and point the Chat
app at `https://<your-host>/chat/events`. Then open
`https://<your-host>/dashboard?token=<DASHBOARD_TOKEN>` — on a fresh
install the dashboard opens the **setup walkthrough**: pick a sign-in
method (Google, SAML, or stay token-only), paste the project **number**
and service-account key, set workspace defaults, optionally enable AI
summaries, and finish onto the home page. Every step can be skipped and
everything can be changed later in Settings (the walkthrough itself is
re-runnable from `/dashboard/setup`). Until the audience is set, AsyncUp
**refuses to process events** (fail closed) and the dashboard shows an
action-needed banner.

Then make the app installable for your people — the
[distribution guide](./distribution) covers the 5-person allowlist path
(minutes) and the private Marketplace admin-install path (~1 hour, whole
domain).

### 1.3 Optional integrations — what each one buys you

| Integration | Setting(s) | What you get |
| --- | --- | --- |
| Calendar OOO sync | Workspace → checkbox + domain-wide delegation | People with an *Out of office* event are auto-marked away |
| Directory API | Workspace → admin email + `admin.directory.user.readonly` scope | Emails resolved for everyone (OOO works before first bot contact); Workspace admin detection for the consoles |
| Google sign-in | Sign in with Google → OAuth web client | Admin/user web consoles with zero per-user setup |
| SAML SSO | Enterprise SSO → IdP entity/URL/cert | Sign-in via any IdP (Google, Okta, Entra, OneLogin) — [details](./enterprise-sso) |
| SCIM provisioning | Access tokens → SCIM token | IdP-driven offboarding: deactivate there → removed from every roster here |
| AI summaries | AI → provider + your key | Daily TL;DR + week-in-review per standup ([guide](./ai)) |
| Outbound webhooks | per standup → Webhook URL | Signed JSON POSTs on submissions and wrap-ups |

### 1.4 Production checklist

- [ ] GCP project number set (webhook verification on — AsyncUp fails closed without it)
- [ ] HTTPS in front of everything
- [ ] Tokens generated only for endpoints you use (`/tick`, `/export`, `/scim/v2`)
- [ ] `SECRET_KEY` backed up **outside** database backups (it encrypts stored secrets and signs sessions/webhooks)
- [ ] Database on persistent storage, backed up
- [ ] Upgrades = deploy the new image; schema migrations run automatically on both SQLite and PostgreSQL

---

## Part 2 — Admin guide

*You create standups and keep them healthy. Everything here needs standup
admin (the `setup` creator, anyone granted `admin @user`, or a Workspace
admin in the web console).*

### 2.1 First standup — and see it work immediately

In the team space:

```
@AsyncUp setup Engineering
@AsyncUp add @Alice @Bob @Carol
@AsyncUp timezone Asia/Kolkata
@AsyncUp time 09:30
@AsyncUp deadline 11:30
@AsyncUp run now          ← opens today's run and prompts everyone right now
```

`run now` is the fastest way to demo the whole loop instead of waiting for
tomorrow; the dashboard's standup page has a matching **▶ Run now** button.
`setup` refuses duplicate names; a mis-created standup is retired with
`archive` (history stays). Multiple standups can share a space — prefix
commands with `#<id>` (ids shown by `status`).

### 2.2 Day-to-day configuration

Chat commands and the dashboard's standup page edit the same settings —
use whichever is at hand. The important semantics:

- **Prompt time is participant-local** — each person is prompted at
  `time` in *their* timezone (set by them via DM `timezone` or `/me`);
  the **deadline is in the standup's timezone** and closes the run for
  everyone.
- **Mandatory vs optional** (`optional @user`) controls who the wrap-up
  counts as missing. Progress views ("3/5 submitted") count everyone who
  isn't away.
- **Roster snapshots**: the day's roster freezes when the run opens;
  changes apply from the next run.
- **`add @user` warns immediately** when the person can't be DMed yet
  (Chat app not installed for them) — nobody fails silently at prompt time.
- **Custom questions** (`questions set Q1 | Q2 | …`, up to 10 × 200 chars):
  questions containing "blocker" get blocker tracking; "yesterday"/"today"
  get pre-fill.

### 2.3 Working blockers

Blockers open automatically from blocker answers. Untagged ones auto-resolve
on the reporter's next clean submission. To work one as an item:
`blocker <id> tag @user` sends an interactive DM card (✋ Acknowledge ·
📝 Add update · ✅ Resolve); tagged blockers need an explicit resolve, nudge
daily until acknowledged, and escalate to the configured contact
(`escalate @user`, threshold `escalate days N`) once stale. `blockers`
lists everything open with age and tags.

### 2.4 Insight and outputs

- `status` — configuration + live progress; `trends` — 4 weeks in chat.
- **Dashboard standup page** — 8-week charts (participation, mood,
  blockers), run history, per-day answers, CSV download.
- `digest on` — weekly digest with week-over-week deltas; `ai on` — AI
  daily/weekly summaries (needs the server-level key).
- **Webhooks** — per-standup URL receives signed JSON on every
  submission/edit and wrap-up ([payloads & verification](#webhooks-ref)).
- `poll Question? | Option A | Option B` — live-updating vote card;
  everyone can start one.

### 2.5 The admin web console

Workspace admins sign straight into `/dashboard` (Google or SAML); operators
can use `?token=` while token sign-in is enabled. Once Google or SAML works
you can switch the token off (Settings → Sign-in & consoles → Token
sign-in). If you later lose the other method, re-enable it directly in the
database and restart:

```sql
DELETE FROM settings WHERE key = 'tokenSignIn';
```

The console covers app settings, per-standup config, roster
management (mandatory/away/admin/remove for people already known to Chat),
Run now, charts, history and CSV. Adding *new* people happens in Chat
(`add @user`) because it needs a Chat identity.

---

## Part 3 — User guide

*You're on a standup roster. Total daily effort: about a minute.*

### 3.1 Your daily flow

At the standup's prompt time (in **your** timezone) AsyncUp DMs you a card:

1. Tap **Fill standup** — one modal, all questions, one submit.
2. Your answers post as your card in the team thread. "Yesterday" comes
   pre-filled from your previous "today".
3. Change of plans? Reopen **Fill standup** before the deadline — your
   posted card updates in place, marked *edited*. After the deadline a
   first submission still posts, marked *late*.
4. Not today? Tap **🏖️ Skip today** — you're listed as away, never as
   missing.

### 3.2 DM commands (message the bot directly)

| Message | Effect |
| --- | --- |
| `vacation` (or `ooo`) | Pause prompts across all your standups |
| `back` | Resume prompts |
| `timezone Asia/Kolkata` | Get prompts at the standup's time in *your* zone |
| `timezone` / `timezone reset` | Show / clear your personal timezone |

### 3.3 Your web console — `/me`

Sign in with Google (or your company's SSO) at `https://<host>/me`:
your standups and today's status, your recent submissions, and the same
vacation/timezone controls as the DMs. If your account isn't linked to Chat
yet, it links automatically the first time you use the bot (or instantly
when the Directory integration is on).

### 3.4 When you're tagged on a blocker

You get a card: **✋ Acknowledge** tells the reporter you're on it (and
stops the daily nudges), **📝 Add update** broadcasts to everyone involved,
**✅ Resolve** closes it. Anyone can also vote in `poll` cards — tap an
option; tap another to change your vote.

---

## Part 4 — Reference

### 4.1 Chat commands (mention the bot in the team space)

Prefix with `#<id>` when the space has several standups. **Open to
everyone**: `help`, `status`, `trends`, `blockers`, `blocker`, `poll`,
`polls`, `export` — plus `setup` (there's nobody to gate it before the
first standup exists). Everything else needs a standup admin.

| Command | Effect |
| --- | --- |
| `setup [name]` | Create a standup (creator becomes admin; duplicate names refused) |
| `run now` | Open today's run immediately and prompt everyone |
| `archive` | Retire the standup — prompts stop, history stays |
| `add @user…` / `remove @user…` | Manage the roster (add warns if the person can't be DMed yet) |
| `mandatory @user…` / `optional @user…` | Count toward the wrap-up, or not |
| `vacation @user…` / `back @user…` | Mark people away / back |
| `admin @user…` / `unadmin @user…` | Grant/revoke standup admin (never below one) |
| `time HH:MM` | Prompt time — participant-local |
| `deadline HH:MM` | Close time — standup timezone |
| `remind <minutes>` | Nudge before the deadline (0 disables, max 1440) |
| `timezone <IANA>` | Standup timezone |
| `days mon,tue,…` | Run days |
| `questions` / `questions set Q1 \| Q2 \| …` / `questions reset` | The form (1–10 questions, ≤200 chars) |
| `mood on\|off\|anon` (also `anonymous`) | Mood dropdown; anon shows only the team average |
| `escalate @user` / `escalate days N` / `escalate off` | Stale-blocker escalation |
| `digest on\|off` / `ai on\|off` | Weekly digest / AI summaries |
| `status` | Config + today's progress (no `#id` → every standup in the space) |
| `trends` | Last 4 weeks: participation and mood |
| `blockers` / `blocker <id> tag\|update\|resolve` | Blocker list / collaboration |
| `poll Q? \| A \| B` / `polls` / `poll <id> results` / `poll <id> close` | Team polls (2–6 options) |
| `export` | How to download the CSV |

DM commands are in [Part 3](#32-dm-commands-message-the-bot-directly).

### 4.2 HTTP endpoints

All token comparisons are constant-time; ✱ = covered by the rate limiter
(60 requests/min/IP).

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | Liveness (pings the DB) |
| `POST /chat/events` | Google-signed JWT (verified against your audience) | Chat webhook — refuses events until the audience is configured |
| `POST /tick` ✱ | Bearer tick token (open until one exists) | External cron for scale-to-zero |
| `GET /export?standupId=N&days=D` ✱ | Bearer export token (404 until one exists) | CSV, D clamped 1–365 |
| `GET /dashboard`, `/dashboard/setup`, `/dashboard/settings`, `/dashboard/standup/:id[...]` ✱ | Admin session or `?token=`/cookie (token only while token sign-in is enabled) | Admin console (home, setup walkthrough, settings, standup page, run-now, roster actions, per-standup CSV, run pages) |
| `GET /me`, `POST /me/timezone`, `POST /me/vacation` ✱ | Session | User console |
| `GET /auth/google`, `GET /auth/callback`, `POST /auth/logout` ✱ | — (OAuth state nonce) | Google sign-in |
| `GET /auth/saml`, `POST /auth/saml/acs`, `GET /auth/saml/metadata` ✱ | — (signed assertions) | SAML sign-in + SP metadata |
| `/scim/v2/ServiceProviderConfig`, `/scim/v2/Users[…]` ✱ | Bearer SCIM token (404 until one exists) | SCIM 2.0: GET (list `startIndex`/`count` ≤200, `userName eq` filter, by id), POST, PUT, PATCH, DELETE; unsupported filters → 501 |

### 4.3 Settings

**Environment variables (bootstrap only)** {#env-vars}

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DB_PATH` | `./data/standup.db` | SQLite file |
| `DATABASE_URL` | – | PostgreSQL instead of SQLite |
| `DB_SSL` / `DB_SSL_CA` | from URL | Postgres TLS mode / CA bundle |
| `DASHBOARD_TOKEN` | – | Operator break-glass for `/dashboard` (with sign-in configured the console also works without it) |
| `SECRET_KEY` | required | Encrypts stored secrets; signs sessions and webhooks |
| `ADAPTER` | `google` | `fake` for a credential-free local demo |
| `TENANT_ID` | `default` | Tenant scoping (multi-tenant installs) |

**Dashboard settings** (stored in the DB, secrets encrypted, applied live;
each value has its own box and saves on its own):
Chat audience + service-account key · AI provider/key/model · default
timezone · Calendar OOO · Workspace admin email · OAuth client ·
SAML IdP (entity ID, SSO URL, certificate, admin attribute + group) ·
token sign-in on/off (off only reachable once Google or SAML works;
recover with `DELETE FROM settings WHERE key = 'tokenSignIn'` + restart) ·
tick / export tokens · SCIM token (lives beside SAML under Sign-in &
consoles, since it pairs with the same IdP). Secrets are write-only — the UI shows *that*
they're set, never the value. The settings UI refuses any change that
would remove the last working sign-in method.

### 4.4 Webhooks {#webhooks-ref}

Per-standup URL (dashboard). JSON POST, 5 s timeout, failures only logged.
Events: `{"event":"submission", standup, date, user, answers, mood, late,
edited}` and `{"event":"wrap_up", standup, date, summary}`. Every delivery
carries `X-AsyncUp-Signature: sha256=<hex>` — HMAC-SHA256 of the raw body
with the standup's signing secret (shown on the dashboard; derived from
`SECRET_KEY`, so rotating that rotates it). Verify with a constant-time
compare and reject mismatches.

### 4.5 Who can do what

| Role | How you get it | What it grants |
| --- | --- | --- |
| Operator | Runs the server (`DASHBOARD_TOKEN`, env) | Everything, including app settings |
| Workspace admin | Google Workspace super/delegated admin (via Directory), or the SAML admin group | Full admin console for all standups |
| Standup admin | Ran `setup`, or granted `admin @user` | Configure that standup from Chat |
| Participant | `add @user` | Submit, edit, skip, DM self-service, `/me` console |
| Everyone in the space | — | `status`, `trends`, `blockers`, polls, `help` |
