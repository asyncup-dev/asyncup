# JSON API

AsyncUp exposes a JSON API under `/api/v1`. It is the front door the web
app uses; everything it does calls the same core functions as the chat
commands. This page tracks the surface as it grows.

## Authentication

Every request needs one of:

| How | Who you are |
| --- | --- |
| Session cookie from Google or SAML sign-in | **admin** if you are a Workspace admin, **manager** if you administer at least one standup, otherwise **member** |
| `Authorization: Bearer <DASHBOARD_TOKEN>` | **admin** (the operator token, while token sign-in is on) |

Unauthenticated calls get `401` with `WWW-Authenticate: Bearer`. Browser
sessions that change state (`POST`, `PATCH`, `DELETE`) must also send
`X-Requested-With: asyncup`, or they get `403 csrf`. Bearer tokens are
exempt — there is no cookie to forge.

Rate limit: 300 requests per minute per client.

## Errors

Every error has one shape:

```json
{ "error": { "code": "not_found", "message": "No such standup.", "field": "optional" } }
```

Codes: `unauthenticated`, `bad_token`, `csrf`, `forbidden`, `not_found`, `invalid` (with `field`), `duplicate`, `lockout`, `chat_unavailable`, `mcp_disabled`, `unavailable`, `already_submitted`, `no_open_run`, `last_admin`, `needs_user`, `not_tagged`, `not_allowed`, `already_acknowledged`, `resolved`, `not_linked`.

## Endpoints

### `GET /api/v1/me`

Who the caller is.

```json
{ "kind": "manager", "via": "session", "tenantId": "default",
  "user": { "userName": "users/1234", "email": "asha@example.com", "name": "Asha" },
  "managedStandupIds": [1] }
```

`user` is `null` for the operator token. `userName` is `null` for a SAML
sign-in that has not been linked to a Chat identity yet.

### `GET /api/v1/standups`

Standups the caller may see: the whole tenant for admins; for everyone
else, the standups they administer or belong to. Each entry:

```json
{ "id": 1, "name": "Engineering", "spaceName": "spaces/AAAA", "active": true,
  "schedule": { "promptTime": "09:30", "deadlineTime": "11:30", "timezone": "Asia/Kolkata",
                "days": ["mon","tue","wed","thu","fri"], "reminderMinutesBefore": 60 },
  "questions": ["What did you do yesterday?", "What will you do today?", "Any blockers?"],
  "mood": { "enabled": true, "anonymous": false },
  "digestEnabled": false,
  "escalation": { "afterDays": 2, "contact": { "userName": "users/99", "displayName": "Priya" } },
  "webhook": { "configured": true },
  "people": { "total": 9, "mandatory": 8 },
  "today": { "date": "2026-09-16", "status": "open", "submitted": 7, "expected": 9,
             "missing": [{ "userName": "users/5", "displayName": "Asha" }] },
  "permissions": { "manage": true } }
```

`today.status` is `null` before the day's run opens. `permissions.manage`
is true for admins and for managers of that standup.

### `GET /api/v1/standups/:id`

The same object plus `participants` (`userName`, `displayName`,
`mandatory`, `timezone`, `onVacation`) and `admins`. Returns `404` for a
standup the caller may not see — including one in another tenant.

### Creating a standup

Admins only. The chat `setup` command and this endpoint share one core, so naming and duplicate rules match.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/templates` | The gallery: `daily-standup`, `weekly-retro`, `mood-check-in`, `sprint-planning`, `blocker-sweep`, `blank`, each with its questions, days, times and mood defaults |
| `GET` | `/spaces` | Spaces the app has been added to, each with the `standups` already reporting there. Answered by the Chat API with the service account; `502 chat_unavailable` carries the reason |
| `GET` | `/spaces/:name/members` | Human members of a space as roster suggestions. `:name` is the resource name URL-encoded (`spaces%2FAAAA`) |
| `POST` | `/standups` | `{ name, spaceName, templateId?, participants?: [{ userName, displayName, mandatory? }], admins?: [{ userName, displayName }], runNow?, …config }` → `201` with the same shape as `GET /standups/:id` plus `template` and `runNow` (the run-now result, or `null`) |

A template seeds the configuration; any config key from `PATCH /standups/:id` sent alongside wins over it (`escalateUserName` must be one of the request's `participants`). A signed-in admin becomes the standup's admin, and `admins` adds managers on top — name one when creating on a team lead's behalf, or from a script with the operator token, since a standup with no admins is open to configuration by anyone in its space. `409 duplicate` when the space already has a standup with that name (case-insensitive).

### Managing a standup

Admins and that standup's managers only (`403 forbidden` otherwise).

| Method | Path | Body / notes |
| --- | --- | --- |
| `PATCH` | `/standups/:id` | Any subset of `name`, `promptTime`, `deadlineTime`, `timezone`, `reminderMinutesBefore`, `escalateAfterDays`, `days` (list or `"mon,tue"`), `webhookUrl` (`null` disables), `questions` (list), `moodEnabled`, `moodAnonymous`, `digestEnabled`, `escalateUserName` (`null` disables). Same rules as the chat commands; `400 invalid` names the `field`. |
| `POST` | `/standups/:id/run-now` | `{ "result": "started" \| "already_open" \| "already_closed" \| "no_participants" }` |
| `POST` | `/standups/:id/nudge` | Reminds everyone still expected today; `409 no_open_run` otherwise |
| `POST` | `/standups/:id/archive`, `/unarchive` | Stops or resumes prompts; history stays |
| `POST` | `/standups/:id/participants` | `{ userName: "users/…", displayName, mandatory? }` → `201` with `reachable` (can the bot DM them) |
| `PATCH` | `/standups/:id/participants/:userName` | `{ mandatory?, onVacation?, admin? }`; `409 last_admin` guards the last admin. `:userName` is the Chat resource name URL-encoded (`users%2F123`) |
| `DELETE` | `/standups/:id/participants/:userName` | `204` |
| `GET` | `/standups/:id/export.csv?days=90` | CSV download |

### Runs

Anyone who can see the standup.

| Path | Returns |
| --- | --- |
| `GET /standups/:id/runs?limit=14` | Recent runs with `submitted`, `expected`, `missing` |
| `GET /standups/:id/runs/today` | Shaped for polling: `status`, `submitted[]` (with `submittedAt`, `late`, `mood`), `waiting[]`, `away[]` (`skipped` or `vacation`), `teamMood` when moods are anonymous |
| `GET /standups/:id/runs/:date` | One run with full submissions and answers |
| `GET /standups/:id/insights?weeks=8` | Weekly participation, mood and blocker series |

Moods are withheld per person when the standup keeps them anonymous; only the team average is returned.

### Blockers

`GET /blockers?status=open|acknowledged|resolved|all&standupId=&owner=` — across every standup the caller can see. Each blocker carries its `status`, `tags` (with `acknowledgedAt`) and `updates`.

`POST /blockers/:id/acknowledge`, `/update` (`{ text }`), `/resolve` — the same rules as in Chat: only tagged people acknowledge; the owner, tagged people and standup admins resolve. These need a signed-in person; the operator token gets `403 needs_user`.

### Team

`GET /people` — admins and managers. Everyone on a roster the caller can see, with `email` (when known), `timezone`, `onVacation` and their `standups` (`mandatory`, `admin`).

### Me

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/me/standups` | `linked: false` until the account has a Chat identity; otherwise `timezone` (own override or `null`), `chat.dmUrl` (deep link to the bot's DM once one exists) and each standup with `today` = `submitted`, `waiting`, `closed` or `null` plus `progress` (`{ submitted, expected }` while a run exists) |
| `GET` | `/me/submissions?limit=10` | My recent answers |
| `PATCH` | `/me` | `{ timezone?: string \| null, onVacation?: boolean }`; `409 not_linked` without a Chat identity |
| `POST` | `/me/skip` | `{ standupId }` — skip today's run, as the DM `skip` command does; `409 no_open_run` before it opens or after it closes, `409 already_submitted` once answered |

### Workspace settings

Admins only.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/settings` | Grouped: `chat`, `workspace`, `signIn`, `tokens`, `setup`. Secrets are never echoed — only `{ "set": true }` (the service account also shows its `email`). |
| `PATCH` | `/settings` | `{ key: value, … }` for any editable field: strings set, `null` clears a secret, an empty string keeps it, booleans for `calendarOoo`, `tokenSignIn`, `setupComplete`. Same rules as the dashboard; `400 invalid` names the `field`; `409 lockout` refuses a change that would leave no working sign-in method. |
| `POST` | `/settings/tokens/:name` | `tick`, `export` or `scim` → `201 { token }`, shown once |
| `DELETE` | `/settings/tokens/:name` | `204` |
| `DELETE` | `/history` | `{ "confirm": "DELETE HISTORY" }` — removes every run, submission, blocker and poll in the workspace; standups, rosters and settings stay. Returns the counts. `400 invalid` without the phrase |

### MCP server

AsyncUp has no AI of its own. Instead it speaks the [Model Context Protocol](https://modelcontextprotocol.io) at `POST /mcp` (Streamable HTTP, stateless), so the team's own assistants — Claude, ChatGPT, an IDE agent — can read standups and, with the right scopes, act as a person. Off by default.

| Method | Path | Notes |
| --- | --- | --- |
| `PATCH` | `/settings` | `mcpEnabled` (boolean) switches the endpoint on; `mcpDefaultScopes` (`"read"`, `"read,blockers:write"`, …) seeds new tokens. `GET /settings` shows the `mcp` section with the scope catalogue |
| `GET` | `/mcp/tokens` | Every token in the tenant for admins; only your own otherwise |
| `POST` | `/mcp/tokens` | `{ name, kind?: "personal" \| "service", scopes?: [...] }` → `201` with the token once (`secret`) and a ready-to-paste `config` (`url`, `headers`). Personal tokens act as you and need a signed-in person; service tokens are admin-only and always read-only |
| `DELETE` | `/mcp/tokens/:id` | Revokes; `204` |
| `GET` | `/mcp/activity?limit=50` | Newest first: `tool`, `argsSummary`, `ok`, `at`, `token` |
| `POST` | `/verify/mcp` | Verification shape: fails while the server is off or no token exists |

Scopes: `read` (list_standups, list_runs, get_run, list_blockers, get_team, get_insights), `blockers:write` (acknowledge_blocker, update_blocker, resolve_blocker), `submit` (submit_answers, today's run only). Tools see exactly what their owner sees in this API; moods stay anonymous where the standup says so. Tokens expire 90 days after their last use and are stored hashed. The endpoint answers `503 mcp_disabled` while switched off and `401` for a missing, unknown, revoked or expired token.

Client config, as returned on creation:

```json
{ "url": "https://asyncup.example.com/mcp", "headers": { "Authorization": "Bearer amcp_…" } }
```

### Verification

Every gate in setup and settings has a live check. All return the same shape:

```json
{ "state": "pass", "detail": "Key verified for bot@… — the app is already in at least one space.",
  "checkedAt": "2026-09-16T10:42:00Z", "data": { "email": "bot@…", "spaces": 3 } }
```

| `POST` | Checks | Who |
| --- | --- | --- |
| `/verify/project` | The stored audience is a project number and/or https app URL | admin |
| `/verify/service-account` | Mints a token from the stored key and calls `spaces.list` | admin |
| `/verify/chat-event` | Whether a verified event has arrived at `/chat/events` since setup began — the gate setup polls while you save the Chat app configuration | admin |
| `/verify/webhook` | `{ standupId }` — POSTs a signed `test` event to the standup's webhook URL | admin, manager |
| `/verify/saml` | Builds a sign-in request from the stored IdP config and checks the SSO URL answers | admin |
| `/verify/dm` | Sends the caller a Chat direct message | any signed-in person |
| `/verify/mcp` | The MCP server is on and at least one token exists | admin |

`GET /health/chat` (no auth) mirrors the connection state without secrets: `audience`, `serviceAccount` (`set` / `unset`), `lastEventAt`, `lastRejectedAt`.
