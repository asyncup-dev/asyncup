# Web app

AsyncUp's console lives at **`https://HOST/app`**. It is a single-page
app served by the same process as the Chat bot and the JSON API, so there is
nothing extra to deploy.

## Signing in

The sign-in page offers whichever methods are configured:

| Method | Who lands where |
| --- | --- |
| **Continue with Google** | Workspace admins get the console; everyone else gets their own page |
| **Continue with SSO** (SAML) | Same split, with the admin role taken from the IdP group attribute |
| **Operator token** (`OPERATOR_TOKEN`) | The console, acting as the workspace operator. Kept in the browser tab only; switch it off under *Settings › Sign-in & SSO* once a real method works |

Setting these up: [Sign-in](./enterprise-sso).

On a fresh install an admin lands in the **guided setup** (`/app/setup`):
Cloud project → service account → Chat app configuration with a live check
for the first signed event → optional sign-in → the first standup from a
template, run immediately. Progress is saved as you go; the welcome page
detects a working Chat connection and skips straight to the standup step.
[Guided setup and first test](./first-standup) walks through it.

## What's there

- **Standups** — stats strip (submitted today, participation, open blockers,
  missing), the table, and per standup: **Overview** (today's run polled live,
  recent runs, open blockers, schedule), **History** (every run with full
  answers, CSV export, and mood comments for people allowed to read them),
  **Insights** (participation by person, mood and blocker
  charts) and **Settings** (schedule with time pickers, questions, mood, the
  People grid and roster group, escalation, webhook with a signed test, digest,
  and a Danger zone to archive, unarchive or delete).
- **Blockers** — every open, acknowledged or resolved blocker across the
  standups you can see, with filters and the same actions as in Chat.
- **Reports** — participation, team mood and blockers over 4, 8 or 12 weeks,
  for all standups or one.
- **Team** — everyone on a roster with role, standups, timezone and status;
  roster changes with confirmation.
- **Settings** — General (default timezone, Calendar out-of-office, leave
  in Chat and Calendar with how its event declines invites and the latest
  failure, and spelling suggestions with the English and words to accept),
  Google Chat (with live verification), Sign-in & SSO,
  MCP server, API & tokens, Roles, Access, Danger zone (disconnect Chat;
  delete all history — both behind a typed confirmation). Each section shows
  only to people with its permission.
- **My standups** (`/app/me`) — for everyone else: today's standup with an
  *Answer in Chat* link and *Skip today* (which asks for a one-line reason),
  recent answers, timezone, vacation mode and *My schedule*.

Admins see the whole workspace. **Managers**, the people who administer a
standup, see and manage their own standups, blockers, reports and team
without Workspace-admin rights. A **Viewer** reads the same pages and changes
nothing. Everyone else gets the personal page. Pages, tabs and buttons follow
each person's permissions, including custom roles
([Roles and permissions](./roles)).

## People

A standup's **Settings → People** grid lists everyone in its Chat space, or
everyone in the Google Group it follows ([Directory and group
rosters](./directory)). Per person:

| Column | Meaning |
| --- | --- |
| On standup | Prompted for this standup |
| Required | Listed as missing when they don't answer. The others still get the prompt but never count as missing |
| Mon–Sun | The days they work. Unticked days mean no prompt, and never missing. The standup's own off days are greyed out |

**Roster** switches between *Picked from the space* and *Everyone in a Google
Group*. Either way, **Last sync** shows when the roster was last checked, with
**Sync now** and the last error.

- *Picked from the space*: anyone who leaves the space comes off the standup,
  and comes back with their old settings if they rejoin. **Last sync** lists
  who is off because they left, with the date. Someone you take off by hand
  stays off, even if they rejoin.
- *Everyone in a Google Group*: people you untick stay off
  ([Directory and group rosters](./directory)).

The create form uses the same grid, with everyone in the space ticked to start.

Personal weeks, days off and time-off approvals also live under **Team → Edit
schedule**, **My page → My schedule** and **Team → Requests** — see
[Personal schedules](./schedules).

**Team → Requests** also lists requests to edit answers after the deadline,
for anyone who can configure the standup: who asked, which standup and day,
their reason, and when the request lapses (midnight in the standup's
timezone). **Approve** lets them edit until then; **Decline…** takes an
optional note sent to them. The first decision wins, in Chat or here.

## Naming, archiving and deleting

- Standup names are unique across the workspace, archived standups included,
  ignoring case. The create form flags a clash before you press Create.
- **Archive** (Danger zone, type `ARCHIVE`) stops prompts and keeps history.
  **Unarchive** resumes on the next scheduled day.
- **Delete** removes an archived standup with every run, answer, blocker and
  poll, after you type its name. Only workspace admins can delete. Messages
  already in Chat stay, and people's own weeks and days off are kept.

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
