# Web dashboard

A lightweight, server-rendered dashboard for configuration and history —
no frontend build, no extra dependencies, shipped inside the same container.

## Enabling

```bash
# .env
DASHBOARD_TOKEN=some-long-random-string
```

The dashboard is **disabled until the token is set**. Open:

```
https://<your-host>/dashboard?token=<DASHBOARD_TOKEN>
```

The token is then remembered in an HttpOnly cookie and the browser is
immediately redirected to a clean URL, so the token doesn't linger in the
address bar, browser history, or proxy access logs.

## Sign in with Google — admin and user consoles

With an OAuth client configured (Settings → *Sign in with Google*), the
consoles map straight onto Google Workspace roles:

- **Workspace admins** (super or delegated, per the Directory API) sign in
  and get this full admin dashboard — no token needed.
- **Everyone else** gets a personal console at **`/me`**: their standups and
  today's status, their recent submissions, and self-service controls for
  timezone and vacation mode — the same things the DM commands do.

Setup: create a **Web application** OAuth client (GCP → APIs & Services →
Credentials) with redirect URI `https://<your-host>/auth/callback`, paste
its ID and secret into Settings, and set the **Workspace admin email** so
admin status can be looked up in the Directory. Sign-ins are rejected for
accounts the Directory doesn't know (or that are suspended); without the
Directory configured, everyone signs in as a regular user and the admin
console stays token-only.

`DASHBOARD_TOKEN` keeps working as break-glass operator access either way.

## What's there

- **First-run checklist** — a setup meter (connect Google Chat, create a
  standup, add your team, optional AI) that disappears once you're rolling.
- **Settings** — *all app configuration lives here*: Google Chat connection
  (project number + paste-in service-account key), AI provider and key,
  default timezone, Calendar OOO sync, and the machine tokens for `/tick`
  and `/export` (generate/clear; shown exactly once). Secrets are stored
  encrypted and never echoed back.
- **Standup list** — every standup with schedule and today's progress.
- **Standup detail** — edit name, times, timezone, days, reminder, questions,
  toggles (mood / anonymous mood / digest / AI / escalation threshold) and the
  escalation contact; manage the roster (mandatory/optional, away/back,
  make/remove admin, remove); a ▶ *Run now* button that opens today's run and
  prompts everyone immediately; and a CSV download of the last 90 days.
- **Run history** — the last 14 runs with submission counts and missing names;
  click into any day to read everyone's full answers.

Adding *new* participants happens in Google Chat (`add @user`) because it
requires a Chat identity the dashboard doesn't know yet; everything about
people already on the roster is manageable here.

## Security notes

- Share the token only with people who should read your team's standups.
- Always serve it behind HTTPS (same reverse proxy as the webhook).
- The cookie is `HttpOnly` + `SameSite=Strict`, so browsers won't attach it
  to cross-site requests (the main line of defence against request forgery).
