# JSON API (preview)

AsyncUp exposes a JSON API under `/api/v1`. It is the front door the web
app uses; everything it does calls the same core functions as the chat
commands. This page tracks the surface as it grows — for now it is
read-only.

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

Codes so far: `unauthenticated`, `bad_token`, `csrf`, `not_found`.

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
