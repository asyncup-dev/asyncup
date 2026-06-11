# Google Chat setup

One-time setup to connect the bot to your Google Workspace. You need to be a
Workspace admin (for domain-wide install) and have a Google Cloud project.

## 1. Create a GCP project and enable the Chat API

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project (e.g. `asyncup`).
2. Note the **project number** (Dashboard → Project info) — you'll paste it into AsyncUp's settings.
3. Enable the API: **APIs & Services → Library → Google Chat API → Enable**.

## 2. Create a service account

1. **IAM & Admin → Service Accounts → Create service account** (e.g. `asyncup`).
   No project roles are needed — Chat API access comes from the app configuration.
2. Open the account → **Keys → Add key → JSON** and download the key file.
   You'll paste its contents into the dashboard in step 3 — no file mounting.

## 3. Deploy the bot and connect it

```bash
cp .env.example .env
# set DASHBOARD_TOKEN (any long random string)
# set SECRET_KEY      (openssl rand -hex 32)
docker compose up -d
```

Expose it over **public HTTPS** behind your reverse proxy
(Caddy/nginx/Traefik) or, for a quick test, a tunnel like
`cloudflared tunnel --url http://localhost:8080`.
Your event URL is `https://<your-host>/chat/events`.

Then open `https://<your-host>/dashboard?token=<DASHBOARD_TOKEN>` →
**Settings → Google Chat** and paste:

- the **project number** from step 1
- the **service-account key JSON** from step 2 (stored encrypted)

Changes apply immediately — no restart. (On Cloud Run you can skip the key
and use the service's own identity via Application Default Credentials.)

## 4. Configure the Chat app

**APIs & Services → Google Chat API → Configuration** tab:

| Field | Value |
| --- | --- |
| App name | `AsyncUp` (or your pick) |
| Avatar URL | `https://asyncup-dev.github.io/asyncup/logo-256.png` (the AsyncUp logo, or any 256×256 PNG) |
| Description | `Async daily standups` |
| Functionality | ✅ Receive 1:1 messages, ✅ Join spaces and group conversations |
| Connection settings | **HTTP endpoint URL** → `https://<your-host>/chat/events` |
| Visibility | **Make this Chat app available to specific people and groups in your domain**, or your whole domain |

Save. The app status should become **LIVE**.

## 5. Install it for your users (admin)

So the bot can DM people without each person adding it manually:

1. [admin.google.com](https://admin.google.com) → **Apps → Google Workspace → Google Chat → Installation policies** (or Marketplace apps, depending on rollout).
2. Install/force-install the app for the OUs or groups who'll use standups.

> The bot can only DM users it shares a DM space with. Admin install creates
> that automatically; otherwise each user must add the app once themselves.

## 6. Create your first standup

1. Create (or open) the space where reports should land.
2. Add the bot to the space (`+ Add people & apps`).
3. Mention it:

```
@AsyncUp setup Engineering
@AsyncUp add @Alice @Bob
@AsyncUp status
```

Prompts go out at the configured time the next working day. 🎉

## Optional: Calendar OOO sync {#calendar-ooo}

To auto-mark people as away when their Google Calendar has an *Out of office*
event, the service account needs **domain-wide delegation**:

1. **IAM & Admin → Service Accounts → your account** → copy the **OAuth 2 Client ID** (a long number).
2. [admin.google.com](https://admin.google.com) → **Security → Access and data control → API controls → Domain-wide delegation → Add new**:
   - Client ID: the number from step 1
   - Scope: `https://www.googleapis.com/auth/calendar.events.readonly`
3. Enable the **Google Calendar API** in your GCP project.
4. Dashboard → **Settings → Workspace** → tick *Google Calendar OOO sync*.

AsyncUp learns each person's email the first time they interact with the bot,
then checks their primary calendar for OOO events when a run opens. People who
are OOO are listed as 🏖️ away — never as missing.

## Troubleshooting

- **"No DM space with users/…"** in logs → that user doesn't have the app installed; see step 5.
- **401 on events** → the value in Settings → Google Chat must be the project *number*, not the project ID.
- **No prompts arriving** → check `docker compose logs`; the scheduler logs every run open/close. Verify the standup `status`, days, and timezone.
- **Replies not threading** → the bot posts with `threadKey`, which threads correctly even if the parent message failed; check the space's history settings.
