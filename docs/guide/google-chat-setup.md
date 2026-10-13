# 2. Google Cloud and the Chat app

Step 2 of the [setup path](./getting-started). You need AsyncUp running at
`https://HOST` ([step 1](./server-setup)) and a Google Cloud account in your
Workspace. The guided setup at `https://HOST/app/setup` shows the same steps
with copy buttons and a live check at each gate; this page explains them.

## Before you start: allow Chat apps

A Workspace admin must allow people to install Chat apps, or you can't message
the app to verify it (section 3) or add it to a space (step 3). In the Admin
console: **Apps → Google Workspace → Google Chat → Chat apps → Allow users to
install Chat apps: On** ([Google's help](https://support.google.com/a/answer/7651360)).
Allowing installs doesn't install anything for anyone.

## 1. Create a Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/projectcreate)
   and create a project, e.g. `asyncup`. Billing is not required.
2. Enable the APIs, under **APIs & Services → Library**:
   - **Google Chat API** — required.
   - **Admin SDK API** — needed for [group rosters and Directory lookups](./directory).
     Enabling it now costs nothing and saves a trip back.
3. Configure the **OAuth consent screen** as **Internal** (**APIs & Services →
   OAuth consent screen**; newer consoles call it *Google Auth Platform*). The
   Chat app can't be configured until this exists, and an internal app needs no
   Google review.
4. Note the **project number** from **Cloud overview → Project info**. It's the
   digits, not the project ID.

In the guided setup, paste the project number on **Create a Google Cloud
project** and press **Verify**.

## 2. Create a service account and key

1. **IAM & Admin → Service accounts → Create service account**, e.g. `asyncup`.
   It needs **no project roles**: Chat access comes from the Chat app
   configuration.
2. Open the account → **Keys → Add key → Create new key → JSON**. A file
   downloads.
3. In the guided setup's **Service account** step, paste the whole file and
   press **Save and verify key**. The key is encrypted at rest with
   `SECRET_KEY`.

The check calls Google Chat as the app, so before the Chat app is configured
(section 3) it may say **Google rejected the key**. That's expected: the key is
saved anyway, and **Continue** works. Come back after section 3 and press
**Verify stored key**; it should pass then.

Keep the service account's email (`asyncup@<project>.iam.gserviceaccount.com`):
[step 5 of the setup path](./directory) gives it an admin role.

The same page has an optional **Calendar out-of-office** switch. Leave it off
for now: it needs domain-wide delegation, covered in
[Calendar out-of-office](./directory#calendar-ooo). Group rosters and user
lookups don't need delegation; they use the [admin role](./directory#admin-role)
from step 5 of the setup path.

## 3. Configure the Chat app

Open **APIs & Services → Google Chat API → Configuration** (the guided setup
links straight to it). Use these values; the guided setup's **Configure the
Chat app** step shows them with your real host filled in:

| Field | Value |
| --- | --- |
| App name | `AsyncUp` (up to 25 characters) |
| Avatar URL | `https://HOST/app/logo-256.png`, or any square HTTPS PNG/JPEG of 256×256 or more |
| Description | `Async daily standups for your team` (up to 40 characters) |
| Build this Chat app as a Google Workspace add-on | Leave ticked, the console default. Unticking it is permanent |
| Enable interactive features | On |
| Functionality | Tick **Join spaces and group conversations**. Direct messages work regardless |
| Connection settings | **HTTP endpoint URL**: `https://HOST/chat/events` |
| Authentication Audience | **HTTP endpoint URL** |
| Commands, link previews | Leave empty / off. AsyncUp uses @mentions |
| Visibility | Everyone in your domain, or specific people and Google Groups ([step 4](./distribution)) |

Save. The app status should become **LIVE**.

### The audience rule

AsyncUp refuses every event until it knows which signature to expect, and it
fails closed. What it needs depends on how the app is built:

| Chat app type | Google signs events for | Store in AsyncUp |
| --- | --- | --- |
| Workspace add-on (today's default) | The endpoint URL, signed by the project's add-on service account | **Both** the project number and `https://HOST/chat/events` |
| Older interaction-event app | The project number | The project number |

With both values stored, either kind verifies. The guided setup stores the
project number in its first step and the URL with **Save audience** on the
Chat app step. In **Settings › Google Chat**, the **Project number** row
changes only the number and keeps the URL.

### Check the connection

On the guided setup's Chat app step:

1. Press **Save audience**. It stores `https://HOST/chat/events` next to the
   project number. Without it, an add-on app's events are refused with `401`.
   The button disappears once the URL is stored.
2. Press **Start listening**, then send any message to AsyncUp in Google Chat
   (find it with **+ → Find apps**). The step turns to **Verified** when the
   first signed event arrives, and **Continue** unlocks.

If nothing arrives, see [Troubleshooting](#troubleshooting).

## Next

[Step 3: guided setup and first test](./first-standup) — create a standup in
a private space and watch a whole run before inviting anyone.

## Optional: group rosters {#roster-group}

Moved to [Directory and group rosters](./directory), with the admin role the
service account needs.

## Optional: Calendar out-of-office {#calendar-ooo}

Moved to [Directory and group rosters](./directory#calendar-ooo).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `401` on events, or the guided setup never verifies | The audience is wrong. Store the project **number** (not the ID) **and**, for an add-on app, `https://HOST/chat/events`. `docker compose logs asyncup` names the exact mismatch |
| "AsyncUp not responding" in Chat, and nothing reaches the server | Something in front of the server answered instead. Cloudflare's Bot Fight Mode is the usual culprit: it challenges Google's `Google-gsuiteaddons` requests and can't be bypassed with a WAF rule on the Free plan, so turn it off for the zone. Any bot challenge, login page or HTML error in front of `/chat/events` has the same effect |
| "AsyncUp not responding", and the server logs the event | The app answered with something Chat refused. Check the logs for an error, and that you run a current image |
| "Could not load dialog. Either the app is not responding or the response is invalid" | Same as above for a dialog. Upgrade to a current image ([Operations](./operations#upgrade)) |
| "No DM space with users/…" in logs | That person can't receive the bot's DMs yet. See [Roll out to your team](./distribution) |
| No prompts arriving | `docker compose logs asyncup` logs every run opening and closing. Check the standup's days, timezone and deadline with `status` |
| Replies not threading | The bot posts with a `threadKey`, which threads even if the parent failed. Check the space's history settings |

A `POST` with an empty JSON body to `https://HOST/chat/events` proves the app
is reachable: before an audience is stored it answers `200` with a "not
connected to Google Chat yet" message, and afterwards `401`, rejecting the
unsigned request. A plain `GET` returns `404`; the route is `POST` only.
