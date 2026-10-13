# 6. Sign-in: Google, SAML and SCIM

Step 6 of the [setup path](./getting-started). Until now you have signed in
with the operator token. Give your team a real sign-in: Workspace admins get the
console, everyone else gets their own page at `/app/me`.

Everything on this page ships in the open-source core. There is no paid tier
and no SSO tax.

| Method | Best for | Admin role comes from |
| --- | --- | --- |
| **Google sign-in** | Google Workspace domains | The Directory: Workspace super and delegated admins ([step 5](./directory)) |
| **SAML** | Any IdP: Google Workspace, Okta, Microsoft Entra, OneLogin | An IdP group attribute, and the Directory when it's set up |
| **Operator token** | The way in before either works, and break-glass after | Always admin |

You can enable both Google and SAML. The sign-in page shows **Continue with
Google**, **Continue with SSO**, and the operator token field while token
sign-in is on. AsyncUp refuses any settings change that would leave no working
sign-in method.

## Google sign-in

1. In the same Cloud project, **APIs & Services → Credentials → Create
   credentials → OAuth client ID**, type **Web application**.
2. Add the **Authorised redirect URI** `https://HOST/auth/callback`.
3. In AsyncUp, **Settings › Sign-in & SSO → Google sign-in** (or the guided
   setup's **Sign-in for your team** step): paste the **OAuth client ID** and
   **OAuth client secret** and save.

The consent screen you made Internal in [step 2](./google-chat-setup) keeps
sign-in to your own domain. Chat identity and web identity are the same Google
account, so nothing needs linking.

Without the [Directory admin role](./directory#admin-role), everyone who signs
in with Google is a regular user and nobody gets the admin console. Use the
operator token, or SAML with an admin group, until the role is in place.

## SAML sign-in

AsyncUp is a standard SAML 2.0 service provider.

| AsyncUp value | |
| --- | --- |
| ACS URL | `https://HOST/auth/saml/acs` |
| SP entity ID / audience | `https://HOST/auth/saml/metadata` |
| Name ID | The user's email |
| Admin attribute | `groups` by default |
| Admin group | `asyncup-admins` by default |

AsyncUp needs three values from the IdP: its **entity ID**, its **SSO URL** and
its **signing certificate** (PEM). Enter them under **Settings › Sign-in & SSO
→ SAML single sign-on**, with the admin attribute and group. SP metadata XML is
served at `https://HOST/auth/saml/metadata` for IdPs that import it, but only
once those IdP values are saved; before that it answers `404`.

### Google Workspace as the IdP

1. **Create the admins group.** Admin console → **Directory → Groups → Create
   group**. Name it `asyncup-admins` and add the people who should get the
   AsyncUp console. Google sends the group's *name* in the assertion, so keep it
   the same as AsyncUp's **Admin group** value, or change that value to match.
2. **Create the app.** Admin console → **Apps → Web and mobile apps → Add app →
   Add custom SAML app**. Name it *AsyncUp*, continue.
3. **Copy Google's IdP details.** The next page shows the **SSO URL**, **Entity
   ID** and **Certificate**. Copy all three into AsyncUp's **SAML single
   sign-on** settings (the certificate including its `BEGIN` and `END` lines)
   and save. Then continue in Google.
4. **Service provider details.**
   - ACS URL: `https://HOST/auth/saml/acs`
   - Entity ID: `https://HOST/auth/saml/metadata`
   - Name ID format: **EMAIL**
   - Name ID: **Basic Information › Primary email**
5. **Attribute mapping.** Under **Group membership**, pick `asyncup-admins` and
   set the app attribute to `groups`. Finish.
6. **Turn the app on.** Open the app's **User access** and set it **ON for
   everyone**, or for the organisational units that use AsyncUp. Until you do,
   Google answers sign-in attempts with a `403` saying the app is not enabled
   for the user.
7. **Test** in a private window: `https://HOST/app` → **Continue with SSO**.
   Admin console changes can take a few minutes to apply.

**Settings › Sign-in & SSO → Check IdP** confirms the SSO URL answers.

### Okta, Entra, OneLogin

Create a SAML 2.0 app with the ACS URL, entity ID and email Name ID above, add
a group attribute named `groups` that carries the admin group, assign the app
to your users, and copy the IdP's entity ID, SSO URL and certificate into
AsyncUp.

### Who becomes an admin

Two paths, either one is enough:

1. **IdP group**: the assertion attribute named by **Admin attribute**
   (default `groups`) contains the **Admin group** value (default
   `asyncup-admins`). The comparison ignores case and must match a whole value.
2. **Google Directory**: with the [Directory admin role](./directory#admin-role)
   in place, Workspace super and delegated admins are admins, as with Google
   sign-in.

Membership: Google sign-in refuses accounts the Directory doesn't know; SAML
deliberately doesn't, because the IdP vouched for the person and the account
may live outside Google (an Okta-only contractor, say). Suspended accounts are
refused on both paths.

Everyone else lands on their personal [page](./web-app) at `/app/me`.

### How SAML users map to Chat

Standup rosters are keyed by Google Chat user ids. A SAML assertion carries an
email, which AsyncUp links to the Chat id through the
[Directory](./directory#user-lookups) on first sign-in, or the first time the
person uses the bot. Until then, `/app/me` shows a "not linked yet" note.

## Switch the operator token off

Once Google or SAML works for at least one admin, switch token sign-in off:
**Settings › Sign-in & SSO → Setup token → Accept the operator token
(OPERATOR_TOKEN) for sign-in**. It covers the token whether you set it as
`OPERATOR_TOKEN` or the older `DASHBOARD_TOKEN`. The token then stops working
for the web app and the JSON API.

If you lock yourself out later, [Operations](./operations#locked-out) has the
recovery.

## SCIM provisioning

AsyncUp serves a SCIM 2.0 Users endpoint at `/scim/v2` for IdPs that push
provisioning: Okta, Entra, OneLogin.

> **Google Workspace cannot push SCIM to custom apps** — its auto-provisioning
> only covers pre-integrated catalogue apps. Pure Google Workspace installs
> should use the [Directory](./directory) instead; SCIM is for organisations
> whose IdP fronts Google.

Setup: generate the **SCIM token** under **Settings › API & tokens →
Machine tokens**, then configure your IdP with base URL `https://HOST/scim/v2` and the
token as the bearer credential. Supported: `ServiceProviderConfig`, list
(`startIndex`/`count`, max 200), get by id, the `userName eq "…"` filter
(dedupe — other filters answer 501), create, PUT/PATCH updates,
deactivate/delete. While no token exists the endpoints answer 404.

What provisioning does:

- **Create/update** registers the user and links them to their Chat identity
  (through the Directory, by email).
- **Deactivate (or delete)** removes the person from **every standup
  roster** — offboarding in the IdP actually offboards them here.
- Reactivating does not restore rosters; an admin adds them back when they
  return.

Adding people to specific standups stays an admin action (the People grid, or
`add @user` in Chat). SCIM has no standup concept, and pushing every
provisioned user into every standup would be wrong more often than right.
