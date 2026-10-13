# 4. Roll out to your team

AsyncUp is **fully self-hosted**, which means *you* (the operator) own all three
moving parts, and they're inseparable:

1. **Server + database** — your container (this is what you run)
2. **GCP project** — the Chat API config + service account
3. **The Chat app on Google's side** — what users actually install

There is **no central AsyncUp app on the Google Workspace Marketplace** that
everyone shares — there can't be. A Marketplace listing is
[tied to one Google Cloud project](https://developers.google.com/workspace/marketplace/enable-configure-sdk),
and a Chat app points at exactly
[one HTTP endpoint](https://developers.google.com/workspace/add-ons/chat/configure).
A single published app routes every install to that one endpoint — so the only
way one listing could serve many orgs is if they all talked to the same server
(that's SaaS). Because AsyncUp runs on *your* server, **you register your own
Chat app in your own Google project.** Your data and credentials never touch the
maintainer or any other org.

This page is only about step 3 — **how your team gets the bot.** For the Cloud
project, service account and Chat app, do [step 2](./google-chat-setup) first.

## The principle that should decide your path

A standup bot only works if **everyone reliably receives their DM prompt** — the
bot can only message someone it shares a DM space with. So the real question is
whether you can count on each person to add the bot themselves, or whether you
want it installed *for* them.

| | Path A — Allowlist + self-add | Path B — Private Marketplace + admin install |
|---|---|---|
| Best for | small teams (≤ a handful, or one Google Group) | whole org / departments, mandatory standups |
| Setup effort | minutes, no Marketplace | ~1 hour one-time (listing + assets) |
| Who installs | each user adds the bot once | admin force-installs for an OU/group |
| Risk | someone forgets → silently never prompted | none — everyone gets it |

## Path A — Visibility allowlist + self-add (small teams)

No Marketplace listing needed.

1. **Admin console** → Apps → Google Workspace → Google Chat → **Chat apps** →
   set **"Allow users to install Chat apps"** to **On**
   ([docs](https://support.google.com/a/answer/7651360)).
2. In your Chat app's **Configuration** (the GCP project), set **Visibility** to
   the people who'll use it. Google allows **up to five individuals, or one or
   more Google Groups** from your domain
   ([docs](https://developers.google.com/workspace/add-ons/chat/configure)) — so
   for more than five people, point it at a **Google Group**.
3. Each user opens Google Chat → **+ → Find apps → AsyncUp → Add**, or just
   messages the bot once. That first interaction creates the DM space so AsyncUp
   can prompt them.

That's it. The catch is step 3: anyone who never adds the bot can't be prompted.
AsyncUp warns when you add someone it can't DM yet (`add @user` in Chat says
so), but a roster that [follows a Google Group](./directory) adds joiners
without that check. Fine for a team you can nudge in a channel; not great for a
mandatory company-wide standup.

## Path B — Private Marketplace listing + admin install (org-wide, zero-touch)

This makes AsyncUp installable org-wide and lets an admin **force-install** it,
so every targeted user (and every future new hire in the OU) gets the bot with a
DM space automatically — no action from them.

**1. Publish a private listing** via the **Google Workspace Marketplace SDK** in
the *same* GCP project as your Chat app
([docs](https://developers.google.com/workspace/marketplace/how-to-publish)):

- Enable the Marketplace SDK, then **APIs & Services → Google Workspace
  Marketplace SDK → App Configuration**: App Visibility = **Private** (your
  domain only), Installation = **Admin Install** (and/or Individual), App
  Integrations = your Chat app.
- **OAuth consent screen = Internal** — a private app to your own domain skips
  Google's public verification review.
- **Store Listing** (all required to publish): name, short/long description,
  **category**, **pricing = Free**, icons (**32×32**, **128×128**), a **220×140**
  banner, **≥1 screenshot**, and **Terms of Service / Privacy Policy / Support**
  URLs. The repo ships the logo as `docs/public/logo.svg` and
  `docs/public/logo-256.png`; scale those for the icons, and take a screenshot
  of your own console or a Chat thread. A private listing's legal URLs can point
  at an internal page.
- **Publish.**

**2. Install it** ([docs](https://support.google.com/a/answer/6089179)):
**Admin console → Apps → Google Workspace Marketplace apps → Apps list → Add app
to allowlist / Install**, scoped to the OU or group that should have AsyncUp.

> **Publish ≠ install.** Publishing the listing only makes it *available*.
> Nobody has the bot until you complete the install/allowlist step in the Admin
> console. This is the single most common place people get stuck.

## The request audience

The Chat app's **Authentication Audience** and what AsyncUp stores must match.
For an app built as a Workspace add-on (the console default), store both the
project number and `https://HOST/chat/events`. See
[the audience rule](./google-chat-setup#the-audience-rule).

## Who's responsible for what (Google side)

| | Maintainer (the project) | You (operator) | Google |
|---|---|---|---|
| GCP project + Chat app + service-account key | ships docs + avatar asset | **owns & configures** | provides the APIs |
| Distribution choice (allowlist vs listing) | documents both | **chooses & configures** | hosts Marketplace |
| Admin install / domain-wide delegation | documents | **performs in your Admin console** | enforces it |
| Marketplace listing + its legal URLs | provides a starter kit | **owns it** (it's in your project) | reviews public listings only |
| Standup data + credentials | **no access, ever** | **data controller** | stores nothing beyond delivery |

The maintainer has **zero access** to your Google project, keys, or data — that's
the point of self-hosting.

## What it costs

**$0 on the Google side, every path.** Registering a Chat app, publishing a
**private** Marketplace listing, and admin-installing it are all free; Chat API
and Calendar API usage is free within quota; an internal app skips paid
verification. You already pay for Google Workspace (Chat is included). Your only
real cost is the server that runs AsyncUp — see
[Deployment reference](./deployment#system-requirements) (≈ $0 if you co-locate on
existing infra, ≈ $5/mo otherwise).

## "AsyncUp not responding" — checklist

If `@AsyncUp setup` says the app isn't responding, Google usually isn't reaching
your endpoint. Check, in order:

1. **App status = Live** in the Chat API Configuration.
2. **Visibility is not empty** — a blank allowlist ("Input is required") means the
   app is visible to *nobody*. Add the people/Group (Path A) or publish + install
   (Path B).
3. **Installed, not just published** — complete the Admin-console install (Path B).
4. **Endpoint reachable over HTTPS** —
   `curl -i -X POST -H 'content-type: application/json' -d '{}' https://HOST/chat/events`
   should answer with JSON (a `401` is fine; it means the app is up and
   rejecting an unsigned probe — a plain GET returns 404, the route is
   POST-only). The app logs every arrival and the concrete 401 reason,
   so check `docker compose logs` to see whether Google's request even arrived.
5. **Audience matches** — AsyncUp has your project **number** and, for an
   add-on app, `https://HOST/chat/events` stored
   ([the audience rule](./google-chat-setup#the-audience-rule)). The logs name
   the exact mismatch.
