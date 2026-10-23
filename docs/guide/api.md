# JSON API

AsyncUp exposes a JSON API under `/api/v1`. It is the front door the web
app uses; everything it does calls the same core functions as the chat
commands. This page explains it; the exact contract is the OpenAPI 3.1
document every server serves at `GET /api/v1/openapi.json` (no sign-in
needed), also published with these docs as
[openapi.json](https://asyncup-dev.github.io/docs/openapi.json). Load it into
any OpenAPI tool to browse the endpoints or generate a client.

The spec and the server cannot drift apart: the test suite checks every
response, and every request the server accepts, against it, and fails when a
route is added without being documented.

## Authentication

Every request needs one of:

| How | Who you are |
| --- | --- |
| Session cookie from Google or SAML sign-in | That person, with the permissions of their roles ([Roles and permissions](./roles)) |
| `Authorization: Bearer <OPERATOR_TOKEN>` | Admin across the workspace (the operator token, while token sign-in is on) |

Each route needs one permission, across the workspace or on the standup it
names. The OpenAPI document gives it as `x-permission` on the operation and
in its description. A caller without it gets `403 forbidden`, or `404` for a
standup they can't see at all.

`GET /api/v1/auth/methods` (which sign-in buttons to show) and
`GET /api/v1/openapi.json` are public. Any other unauthenticated call gets
`401` with `WWW-Authenticate: Bearer`. Browser
sessions that change state (`POST`, `PATCH`, `DELETE`) must also send
`X-Requested-With: asyncup`, or they get `403 csrf`. Bearer tokens are
exempt — there is no cookie to forge.

Rate limit: 300 requests per minute per client.

## Errors

Every error has one shape:

```json
{ "error": { "code": "not_found", "message": "No such standup.", "field": "optional" } }
```

Codes: `unauthenticated`, `bad_token`, `csrf`, `forbidden`, `not_found`, `invalid` (with `field`), `duplicate`, `active` (delete a standup that isn't archived), `lockout`, `chat_unavailable`, `unavailable`, `roster_unavailable` (Google refused the group read or the space check, with why), `already_submitted`, `no_open_run`, `last_admin`, `needs_user`, `not_tagged`, `not_allowed`, `already_acknowledged`, `resolved`, `not_linked`, `refused` (a time-off policy said no, with the reason), `escalation` (a role or grant would give more than you hold), `built_in` (built-in roles can't be changed), `in_use` (a role someone holds), `workspace_only` (that role can only be granted across the workspace).

## Endpoints

### `GET /api/v1/me`

Who the caller is.

```json
{ "kind": "manager", "via": "session", "tenantId": "default",
  "user": { "userName": "users/1234", "email": "asha@example.com", "name": "Asha" },
  "managedStandupIds": [1],
  "permissions": { "workspace": ["standups.view", "reports.view"],
                   "standups": { "1": ["standups.configure", "people.manage", "…"] } } }
```

`user` is `null` for the operator token. `userName` is `null` for a SAML
sign-in that has not been linked to a Chat identity yet. `permissions.standups`
adds to `permissions.workspace` on each standup. `kind` is a coarse summary
for laying out a client: `admin` with `settings.manage`, `manager` with
anything beyond a Member's, otherwise `member`.

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
  "timeOffPolicy": "self",
  "escalation": { "afterDays": 2, "contact": { "userName": "users/99", "displayName": "Priya" } },
  "webhook": { "configured": true },
  "roster": { "group": null, "syncedAt": null, "error": null },
  "people": { "total": 9, "mandatory": 8 },
  "today": { "date": "2026-09-16", "status": "open", "submitted": 7, "expected": 9,
             "missing": [{ "userName": "users/5", "displayName": "Asha" }] },
  "permissions": { "manage": true } }
```

`today.status` is `null` before the day's run opens. `permissions.manage`
is true for admins and for managers of that standup. `roster.group` is the
Google Group email the roster follows, or `null` when people are picked by
hand; `syncedAt` and `error` describe the last sync.

### `GET /api/v1/standups/:id`

The same object plus:

- `participants`: `userName`, `displayName`, `mandatory`, `timezone`,
  `onVacation`, `workingDays` (their own days on this standup, or `null` to
  follow its days), `otherStandups` (how many other standups they're on) and `source`
  (`manual` or `group`);
- `admins`;
- `keptOff`: group members taken off by hand, whom syncs keep off;
- `roster`: `group`, `syncedAt` and `error` for either kind of roster, and
  `leftSpace`: on a roster picked from the space, people taken off for leaving
  it, each with `at`, until they rejoin or a manager acts.

Returns `404` for a standup the caller may not see — including one in another
tenant.

### Creating a standup

Needs `standups.create`. The chat `setup` command and this endpoint share one core, so naming and duplicate rules match.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/templates` | The gallery: `daily-standup`, `weekly-retro`, `mood-check-in`, `sprint-planning`, `blocker-sweep`, `blank`, each with its questions, days, times and mood defaults |
| `GET` | `/spaces` | Spaces the app has been added to, each with the `standups` already reporting there. Answered by the Chat API with the service account; `502 chat_unavailable` carries the reason |
| `GET` | `/spaces/:name/members` | Human members of a space as roster suggestions. `:name` is the resource name URL-encoded (`spaces%2FAAAA`) |
| `POST` | `/standups` | `{ name, spaceName, templateId?, participants?: [{ userName, displayName, mandatory? }], rosterGroup?, admins?: [{ userName, displayName }], runNow?, …config }` → `201` with the same shape as `GET /standups/:id` plus `template` and `runNow` (the run-now result, or `null`). With `rosterGroup` (a Google Group email) the roster follows the group and syncs straight away |

A template seeds the configuration; any config key from `PATCH /standups/:id` sent alongside wins over it (`escalateUserName` must be one of the request's `participants` or `admins`). A signed-in admin becomes the standup's admin, and `admins` adds managers on top — name one when creating on a team lead's behalf, or from a script with the operator token, since a standup with no admins is open to configuration by anyone in its space. `409 duplicate` when any standup in the workspace, archived ones included, already has that name (case-insensitive). Renaming through `PATCH /standups/:id` follows the same rule and answers `400 invalid` on `name`.

### Managing a standup

Each route needs a permission on that standup: `standups.configure` for `PATCH`, run now, nudge and the webhook secret; `standups.archive` to archive; `people.manage` for participants, space members and roster sync; `export` for the CSV; and `standups.delete`, across the workspace, to delete.

| Method | Path | Body / notes |
| --- | --- | --- |
| `PATCH` | `/standups/:id` | Any subset of `name`, `promptTime`, `deadlineTime`, `timezone`, `reminderMinutesBefore`, `escalateAfterDays`, `days` (list or `"mon,tue"`), `timeOffPolicy` (`self` \| `approval` \| `managers`, see [Personal schedules](./schedules)), `webhookUrl` (`null` disables), `questions` (list), `moodEnabled`, `moodAnonymous`, `digestEnabled`, `escalateUserName` (`null` disables; a participant or one of the standup's admins), `rosterGroup` (a Google Group email; `null` or empty goes back to people picked by hand). Same rules as the chat commands; `400 invalid` names the `field`. |
| `POST` | `/standups/:id/run-now` | `{ "result": "started" \| "already_open" \| "already_closed" \| "past_deadline" \| "no_participants" }` |
| `POST` | `/standups/:id/nudge` | Reminds everyone still expected today; `409 no_open_run` otherwise |
| `POST` | `/standups/:id/archive`, `/unarchive` | Stops or resumes prompts; history stays |
| `DELETE` | `/standups/:id` | `{ "confirm": "<the standup's name>" }` removes an **archived** standup with every run, answer, blocker and poll, and returns the counts; `409 active` until it is archived, `400 invalid` for a wrong name. People's own weeks and days off stay; messages already posted in Chat are not touched |
| `POST` | `/standups/:id/participants` | `{ userName: "users/…", displayName, mandatory? }` → `201` with `reachable` (can the bot DM them) |
| `PATCH` | `/standups/:id/participants/:userName` | `{ mandatory?, onVacation?, admin? }`; `409 last_admin` guards the last admin. `:userName` is the Chat resource name URL-encoded (`users%2F123`) |
| `DELETE` | `/standups/:id/participants/:userName` | `204`. On a group roster the person is kept off: later syncs don't add them back |
| `GET` | `/standups/:id/webhook/secret` | `{ secret }`: the key the standup's webhooks are signed with ([webhooks](./configuration#outbound-webhooks)); `503 unavailable` when the server has no signing key |
| `GET` | `/standups/:id/members` | Members of the standup's Chat space, as roster candidates; `502 chat_unavailable` carries Google's reason |
| `POST` | `/standups/:id/roster/sync` | Sync the roster now → `{ added: [names], removed: [names], skipped: [{ email, reason }], syncedAt }`. A group roster follows the group. A roster picked from the space is checked against the space: `removed` were taken off for leaving it, `added` put back after rejoining. `502 roster_unavailable` when Google refuses or the space can't be checked (the message says why, and nobody is taken off), `503` when the server has no roster support |
| `GET` | `/standups/:id/export.csv?days=90` | CSV download |

### Runs

Today's run needs `standups.view`; the run list and insights need `reports.view`; one run's answers need `answers.view`.

| Path | Returns |
| --- | --- |
| `GET /standups/:id/runs?limit=14` | Recent runs with `submitted`, `expected`, `missing` |
| `GET /standups/:id/runs/today` | Shaped for polling: `status`, `submitted[]` (with `submittedAt`, `late`, `mood`), `waiting[]`, `away[]` (with `reason`, and `note` holding a skip's reason), `teamMood` when moods are anonymous |
| `GET /standups/:id/runs/:date` | One run with full submissions and answers |
| `GET /standups/:id/insights?weeks=8` | Weekly participation, mood and blocker series |

Requests to edit answers after the deadline are decided by anyone holding `standups.configure` on the standup:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/edit-requests` | Pending requests the caller can decide, newest first: `standupId`, `standupName`, `date`, `userName`, `displayName`, `reason`, `askedAt`, `answeredAt` and `until` (midnight in the standup's timezone, as `23:59 Europe/London`) |
| `POST` | `/edit-requests/:id/approve` · `/edit-requests/:id/decline` | `{ note? }` on decline goes to the person; `404` for an unknown request, `403` without `standups.configure` on its standup, `409 refused` once decided or lapsed, or for the caller's own request |

Polls with questions are sent and closed by anyone holding `standups.configure` on the standup:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/standups/:id/question-polls` | Newest first: `title`, `from`, `closesAt` and `closesLabel` (the close time in the standup's timezone), `closedAt`, `open`, `anonymous`, `results` (`everyone` or `managers`), `asked`, `answered` |
| `POST` | `/standups/:id/question-polls` | `{ title, intro?, questions: [{ text, type, required?, options? }], closesAt: "2026-10-24T17:00", remindMinutes?: 15 \| 60 \| 1440 \| null, anonymous?, results? }`. `type` is `short`, `long`, `dropdown`, `single` or `multiple`; up to 10 questions and 20 options. `closesAt` is local to the standup, from 15 minutes to 14 days ahead. Answers `201` with the poll, or `400 invalid` naming the `field` |
| `GET` | `/question-polls/:id` | The poll and its `questions`. `outcome` (who hasn't answered, counts per option with names, text answers) is set for the standup's managers, and for the people asked once a poll with `results: everyone` closes; otherwise `null`. Names are `null` on an anonymous poll |
| `POST` | `/question-polls/:id/close` | Close it now; `409 closed` if it already has |
| `GET` | `/question-polls/:id/export.csv` | One row per answer: `person,question,answer,answered_at`, without `person` on an anonymous poll. Managers only |

Moods are withheld per person when the standup keeps them anonymous; only the team average is returned. A run includes `moodComments` only for callers holding `moods.comments` on the standup: each with `person`, `mood` and `comment`, or with `person: null`, sorted by mood then text, when moods are anonymous.

### Blockers

`GET /blockers?status=open|acknowledged|resolved|all&standupId=&owner=` — across every standup where the caller has `blockers.view`. Each blocker carries its `status`, `tags` (with `acknowledgedAt`) and `updates`.

`POST /blockers/:id/acknowledge`, `/update` (`{ text }`), `/resolve` — the same rules as in Chat: only tagged people acknowledge; the owner, tagged people and anyone with `blockers.manage` on the standup resolve. These need a signed-in person; the operator token gets `403 needs_user`.

### Team

`GET /people` — needs `people.view`. Everyone on a roster of a standup where the caller has it, with `email` (when known), `timezone`, `onVacation`, `workingDays` / `workingDaysLabel` (*Varies by standup* when their days differ) and their `standups` (`mandatory`, `admin`).

Schedules of others need `schedules.manage` on a standup the person is on:

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/people/:userName/schedule` | Same shape as `/me/schedule`; `standups` lists only the standups the caller manages |
| `PATCH` | `/people/:userName/schedule` | `{ workingDays, standupId }` — needs `schedules.manage` on that standup; the person is DM'd |
| `POST` | `/people/:userName/overrides` | Same body as `/me/overrides`; managers may set past dates and are never subject to the policy — the person is DM'd |
| `DELETE` | `/people/:userName/overrides/:date` | Withdraw |
| `GET` | `/requests` | Pending time-off requests: all of them with `schedules.manage` across the workspace, otherwise those of people on standups where the caller has it |
| `POST` | `/requests/:ids/approve` · `/requests/:ids/decline` | `:ids` comma-separated (one request can span several dates); `{ note? }` on decline goes to the person; `409 refused` once decided or when the caller doesn't manage the person |

### Me

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/me/standups` | `linked: false` until the account has a Chat identity; otherwise `timezone` (own override or `null`), `chat.dmUrl` (deep link to the bot's DM once one exists) and each standup with `today` = `submitted`, `waiting`, `closed` or `null` plus `progress` (`{ submitted, expected }` while a run exists) |
| `GET` | `/me/submissions?limit=10` | My recent answers, with my own `moodComment` |
| `PATCH` | `/me` | `{ timezone?: string \| null, onVacation?: boolean }`; `409 not_linked` without a Chat identity |
| `GET` | `/me/schedule` | My days on each standup (`standups`: `standupId`, `name`, the standup's `days`, my `workingDays` and `workingDaysLabel`, `timeOffPolicy`), the `policies` of my standups and upcoming `overrides` (each with `status`, `setBy`, `channel`, `decidedBy`). The top-level `workingDays` and `workingDaysLabel` are deprecated |
| `PATCH` | `/me/schedule` | `{ workingDays: "mon-thu" \| "adhoc" \| "reset", standupId }` — the same words the DM `days` command takes, for one standup; `400 invalid` otherwise. Without `standupId` every standup changes; that form is deprecated |
| `POST` | `/me/overrides` | `{ date }`, `{ dates: [] }` or `{ from, to }` (ISO, ≤ 31 days), `working?: boolean`, `reason?` — a day off or an extra working day; `403 refused` when the standup's time-off policy says so, with the reason |
| `DELETE` | `/me/overrides/:date` | Withdraw an entry |
| `POST` | `/me/skip` | `{ standupId, reason }` — skip today's run with a one-line reason (up to 150 characters), posted in the day's thread; `400 invalid` on `reason` when it is missing or too long, `409 no_open_run` before it opens or after it closes, `409 already_submitted` once answered |

### Workspace settings

Reading needs any of `settings.manage`, `sso.manage`, `tokens.manage` or `roles.manage`. Each field then needs its own: the sign-in fields `sso.manage`, `samlAdminAttribute` and `samlAdminGroup` `roles.manage` (they decide who is an admin), `mcpDefaultScopes` `tokens.manage`, and the rest `settings.manage`. Machine tokens need `tokens.manage`; deleting history needs `settings.manage`.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/settings` | Grouped: `chat`, `workspace` (including `leaveInChat`, `leaveDeclineMode`, `leaveSyncError: { message, at }` or `null`, and `spelling: { enabled, dialect, words }`), `signIn`, `tokens`, `setup`, `mcp`. Secrets are never echoed — only `{ "set": true }` (the service account also shows its `email`). |
| `PATCH` | `/settings` | `{ key: value, … }` for any editable field: strings set, `null` clears a secret, an empty string keeps it, booleans for `calendarOoo`, `leaveInChat`, `spellingEnabled`, `tokenSignIn`, `setupComplete`, `mcpEnabled`; `leaveDeclineMode` is `none`, `new` or `all`; `spellingDialect` is `en-GB` or `en-US`; `spellingWords` is one word per line. Same rules as the web app; `400 invalid` names the `field`; `409 lockout` refuses a change that would leave no working sign-in method. |
| `POST` | `/settings/tokens/:name` | `tick`, `export` or `scim` → `201 { token }`, shown once |
| `DELETE` | `/settings/tokens/:name` | `204` |
| `DELETE` | `/history` | `{ "confirm": "DELETE HISTORY" }` — removes every run, submission, blocker and poll in the workspace; standups, rosters and settings stay. Returns the counts. `400 invalid` without the phrase |

### Roles and grants

Custom roles and who holds what ([Roles and permissions](./roles)). Every change is written to the audit log.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/permissions` | The permission catalogue: `id`, `label`, `description`, `workspaceOnly`. Anyone signed in |
| `GET` | `/roles` | Built-in and custom roles with `permissions`, `builtIn`, `grantable`, `workspaceOnly` and the number of `grants`. Needs `roles.manage`, or `people.manage` on some standup |
| `POST` | `/roles` | `{ name, description?, permissions: [...] }` → `201`. Needs `roles.manage`. `403 escalation` for a permission you don't hold, `409 duplicate` for a taken name. `standups.view` is added whenever another standup permission is chosen |
| `PATCH` | `/roles/:id` | Same body. Custom roles only (`400 built_in`); `409 lockout` when it would take away your own `roles.manage` |
| `DELETE` | `/roles/:id` | `204`; `409 in_use` while anyone holds it |
| `GET` | `/grants?standupId=` | Grants the caller may change: all of them with `roles.manage`, otherwise those on standups where they have `people.manage` |
| `POST` | `/grants` | `{ email, displayName?, role, standupId? }` → `201`. Omit `standupId` for the whole workspace, which needs `roles.manage`; on one standup, `people.manage` there is enough. `403 escalation` for a role holding more than you do there, `400 workspace_only` for a workspace-only role on one standup, `409 duplicate` when they already hold it there |
| `DELETE` | `/grants/:id` | `204`. Same escalation rule; `409 lockout` for your own last `roles.manage` |
| `GET` | `/roles/audit?limit=100` | Newest first: `at`, `actor`, `action`, `summary`. Needs `roles.manage` |

### MCP server

AsyncUp has no AI of its own. Instead it speaks the [Model Context Protocol](https://modelcontextprotocol.io) at `/mcp` (Streamable HTTP, stateless), so the team's own assistants can read standups and, with the right scopes, act as a person. Off by default. Setting up Claude Code, the tool list and what each scope allows are in [Claude Code and MCP](./mcp); this section covers the API that manages it.

| Method | Path | Notes |
| --- | --- | --- |
| `PATCH` | `/settings` | `mcpEnabled` (boolean) switches the endpoint on; `mcpDefaultScopes` (`"read"`, `"read,blockers:write"`, …) seeds new tokens. `GET /settings` shows the `mcp` section with the scope catalogue |
| `GET` | `/mcp/tokens` | Every token in the tenant with `tokens.manage`; only your own otherwise |
| `POST` | `/mcp/tokens` | `{ name, kind?: "personal" \| "service", scopes?: [...] }` → `201` with the token once (`secret`) and a ready-to-paste `config` (`url`, `headers`). Personal tokens act as you and need a signed-in person; service tokens need `tokens.manage` and are always read-only |
| `DELETE` | `/mcp/tokens/:id` | Revokes; `204` |
| `GET` | `/mcp/activity?limit=50` | Newest first: `tool`, `argsSummary`, `ok`, `at`, `token` |
| `POST` | `/verify/mcp` | Verification shape: fails while the server is off or no token exists |

Scopes: `read`, `blockers:write`, `submit`, `schedule` and `manage` — see [Claude Code and MCP](./mcp#_2-create-a-token) for the tools each one unlocks. Tools see exactly what their owner sees in this API and return the same shapes; moods stay anonymous where the standup says so. Tokens expire 90 days after their last use and are stored hashed. The endpoint answers `503 mcp_disabled` while switched off, `401` for a missing, unknown, revoked or expired token, and `403` for any request that carries an `Origin` header.

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

| `POST` | Checks | Needs |
| --- | --- | --- |
| `/verify/project` | The stored audience is a project number and/or https app URL | `settings.manage` |
| `/verify/service-account` | Mints a token from the stored key and calls `spaces.list` | `settings.manage` |
| `/verify/chat-event` | Whether a verified event has arrived at `/chat/events` since setup began — the gate setup polls while you save the Chat app configuration | `settings.manage` |
| `/verify/webhook` | `{ standupId }` — POSTs a signed `test` event to the standup's webhook URL | `standups.configure` on it |
| `/verify/saml` | Builds a sign-in request from the stored IdP config and checks the SSO URL answers | `sso.manage` |
| `/verify/dm` | Sends the caller a Chat direct message | any signed-in person |
| `/verify/mcp` | The MCP server is on and at least one token exists | `settings.manage` |

`GET /health/chat` (no auth) mirrors the connection state without secrets: `audience`, `serviceAccount` (`set` / `unset`), `lastEventAt`, `lastRejectedAt`.
