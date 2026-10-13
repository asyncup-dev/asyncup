# Google Chat setup

One-time setup to connect the bot to your Google Workspace. You need to be a
Workspace admin (for domain-wide install) and have a Google Cloud project.

## 1. Create a GCP project and enable the Chat API

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project (e.g. `asyncup`).
2. Note the **project number** (Cloud overview → Project info) — you'll paste it into AsyncUp's setup.
3. Enable the API: **APIs & Services → Library → Google Chat API → Enable**.

## 2. Create a service account

1. **IAM & Admin → Service Accounts → Create service account** (e.g. `asyncup`).
   No project roles are needed — Chat API access comes from the app configuration.
2. Open the account → **Keys → Add key → JSON** and download the key file.
   You'll paste its contents into AsyncUp's setup in step 3 — no file mounting.

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

Then open `https://<your-host>/app`, sign in with `DASHBOARD_TOKEN` →
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
| Avatar URL | `https://asyncup-dev.github.io/logo-256.png` (the AsyncUp logo, or any 256×256 PNG) |
| Description | `Async daily standups` |
| Functionality | ✅ Receive 1:1 messages, ✅ Join spaces and group conversations |
| Connection settings | **HTTP endpoint URL** → `https://<your-host>/chat/events` |
| Authentication Audience | **Project Number** (recommended — this is what AsyncUp verifies) |
| Visibility | the people/Google Group who'll use it (see below) |

> Today's console defaults to **"Build this Chat app as a Google Workspace
> add-on."** Leave it ticked (clearing it is permanent). Add-on apps send a
> different event format and expect a different response envelope; AsyncUp
> detects which one Google is using per request and answers accordingly, so
> both work. The add-on path needs the same distribution steps below.

Save. The app status should become **LIVE**. In the app's Settings › Google Chat,
enter **both** the project number and your `https://<your-host>/chat/events` URL,
space-separated. Interaction-event apps sign requests for the project number;
add-on apps sign them for the URL and identify themselves with the project's
add-on service account, which AsyncUp derives from the number.

## 5. Get the bot to your team

How users actually receive the bot — allowlist + self-add (small teams) vs a
private Marketplace listing + admin install (org-wide, zero-touch) — is its own
topic. **See [Installing AsyncUp for your team](./distribution).**

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
   - Scopes (comma-separated):
     `https://www.googleapis.com/auth/calendar.events.readonly, https://www.googleapis.com/auth/admin.directory.user.readonly`
3. Enable the **Google Calendar API** and **Admin SDK API** in your GCP project.
4. In the app, **Settings › General** → tick *Calendar out-of-office* and
   set the **Workspace admin email**.

With the admin email set, AsyncUp resolves each person's email through the
Directory API (Directory reads must impersonate an admin), so OOO sync works
even for people who never interacted with the bot. Without it, emails are
learned the first time each person uses the bot. People who are OOO are
listed as 🏖️ away — never as missing.

The `admin.directory.user.readonly` scope is read-only. If you skip it and
leave the admin email empty, everything else works unchanged.

## Optional: rosters from a Google Group {#roster-group}

A standup can follow a Google Group instead of people picked from its space.
Everyone in the group, including members of nested groups, is on the standup.
Joiners get the default setup: prompted, counted when they miss it, and
following the standup's days. Leavers drop off, and their history stays.
People you take off by hand stay off, and people you add by hand stay on.

Pick **Everyone in a Google Group** under the standup's **Settings › People**,
or when you create the standup, and enter the group's email address. The
roster syncs straight away, then hourly, and again in the hour before each
run. **Sync now** shows who was added, who was removed, and who was skipped
and why: people outside your Workspace, suspended accounts, and accounts that
aren't active.

AsyncUp reads groups as its service account, with an admin role and no
domain-wide delegation, as Google recommends:

1. In the Google Cloud project that holds the service account, enable the
   **Admin SDK API**.
2. In the Admin console, go to **Account › Admin roles › Create new role**.
   Give it only **Admin API privileges › Groups › Read** and **Users › Read**.
3. Open the new role, click **Assign service accounts**, and enter the service
   account's email. Use the service account, not a person: AsyncUp calls Google
   as the service account.

A new role can take up to about 15 minutes to apply. Until then, a sync says
it can't read the group, and names the role to grant.

## Troubleshooting

- **"No DM space with users/…"** in logs → that user doesn't have the app installed; see step 5.
- **401 on events** → the value in Settings → Google Chat must be the project *number*, not the project ID.
- **"AsyncUp not responding" in Chat, Google's log says "Can't handle the app's response", and nothing reaches the server** → something in front of the server answered instead. Cloudflare's Bot Fight Mode is the usual culprit: it challenges Google's `Google-gsuiteaddons` requests to `/chat/events` and cannot be bypassed with a WAF rule on the Free plan, so turn it off for the zone (or use Super Bot Fight Mode's allow rules on Pro). Any bot challenge, login page or HTML error in front of `/chat/events` has the same effect.
- **No prompts arriving** → check `docker compose logs`; the scheduler logs every run open/close. Verify the standup `status`, days, and timezone.
- **Replies not threading** → the bot posts with `threadKey`, which threads correctly even if the parent message failed; check the space's history settings.
