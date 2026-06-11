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

The token is then remembered in an HttpOnly cookie, so subsequent navigation
doesn't need the query parameter.

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
  and toggles (mood / anonymous mood / digest / AI / escalation threshold);
  see participants, admins, open blockers, and a 4-week trend table.
- **Run history** — the last 14 runs with submission counts and missing names;
  click into any day to read everyone's full answers.

Participants, admins, and the escalation contact are managed from Google Chat
(`add`, `admin`, `escalate @user`) because they require Chat identities.

## Security notes

- Share the token only with people who should read your team's standups.
- Always serve it behind HTTPS (same reverse proxy as the webhook).
- The cookie is `HttpOnly` + `SameSite=Strict`, which also guards the config
  form against cross-site request forgery.
