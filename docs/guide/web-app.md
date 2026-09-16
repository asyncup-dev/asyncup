# Web app

AsyncUp's console lives at **`https://<your-host>/app`**. It is a single-page
app served by the same process as the Chat bot and the JSON API, so there is
nothing extra to deploy.

## Signing in

The sign-in page offers whichever methods are configured:

| Method | Who lands where |
| --- | --- |
| **Sign in with Google** | Workspace admins get the console; everyone else gets their own page |
| **Continue with SSO** (SAML) | Same split, with the admin role taken from the IdP group attribute |
| **Operator token** (`DASHBOARD_TOKEN`) | The console, acting as the workspace operator. Kept in the browser tab only; switch it off under *Settings › Sign-in & SSO* once a real method works |

On a fresh install an admin lands in the **guided setup** (`/app/setup`):
Cloud project → service account → Chat app configuration with a live check
for the first signed event → optional sign-in → the first standup from a
template, run immediately. Progress is saved as you go; the welcome page
detects a working Chat connection and skips straight to the standup step.

## What's there

- **Standups** — stats strip (submitted today, participation, open blockers,
  missing), the table, and per standup: **Overview** (today's run polled live,
  recent runs, open blockers, schedule), **History** (every run with full
  answers, CSV export), **Insights** (participation by person, mood and blocker
  charts) and **Settings** (schedule, questions, mood, roster, escalation,
  webhook with a signed test, digest, archive).
- **Blockers** — every open, acknowledged or resolved blocker across the
  standups you can see, with filters and the same actions as in Chat.
- **Reports** — participation, team mood and blockers over 4, 8 or 12 weeks,
  for all standups or one.
- **Team** — everyone on a roster with role, standups, timezone and status;
  roster changes with confirmation.
- **Settings** — General, Google Chat (with live verification), Sign-in & SSO,
  MCP server, API & tokens, Danger zone (disconnect Chat; delete all history —
  both behind a typed confirmation).
- **My standups** (`/app/me`) — for everyone else: today's standup with an
  *Answer in Chat* link and *Skip today*, recent answers, timezone and vacation
  mode.

Admins see the whole workspace. **Managers** — people who administer at least
one standup — see and manage their own standups, blockers, reports and team
without Workspace-admin rights. Everyone else gets the personal page.

## Security notes

- Browser sessions are signed cookies (`SECRET_KEY`); state-changing API calls
  from the app carry an `X-Requested-With` header as CSRF proof.
- The operator token is only ever sent as a bearer header and is never stored
  server-side beyond the environment variable.
- Secrets (service-account key, OAuth secret, SAML certificate) are encrypted
  at rest and never echoed back by the API — the app only ever learns that
  they are set.
- The API and the app share one authorisation model; see the
  [API guide](./api) for the exact rules per endpoint.
