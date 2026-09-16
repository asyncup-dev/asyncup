# Enterprise SSO: SAML + SCIM

Everything on this page ships in the open-source core — there is no paid
tier and no SSO tax. Google sign-in (OIDC) stays available alongside; use
whichever fits your install.

## SAML sign-in

AsyncUp is a standard SAML 2.0 service provider. Any IdP works — Google
Workspace, Okta, Microsoft Entra, OneLogin.

**In AsyncUp** (dashboard → Settings → *Enterprise SSO*): paste your IdP's
entity ID, SSO URL, and X.509 certificate.

**In your IdP**: create a custom SAML app with

| Field | Value |
| --- | --- |
| ACS URL | `https://<your-host>/auth/saml/acs` |
| SP entity ID / audience | `https://<your-host>/auth/saml/metadata` |
| NameID | the user's email |

SP metadata XML is served at `/auth/saml/metadata` for IdPs that import it.
The sign-in pages then show a *Sign in with SSO (SAML)* button.

### Who becomes an admin

Two paths, OR'd — whichever your install has configured grants the admin
console:

1. **IdP group** — an assertion attribute (default name `groups`) containing
   the admin value (default `asyncup-admins`). Both configurable in Settings.
2. **Google Directory** — when the [Directory integration](./google-chat-setup#calendar-ooo)
   is configured, Workspace admins (super or delegated) are admins
   automatically, same as with Google sign-in.

Membership note: Google sign-in rejects accounts the Directory doesn't know;
SAML deliberately doesn't — the IdP itself asserted org membership, and the
account may live outside Google (e.g. Okta-only contractors). Suspended
accounts are rejected on both paths.

Everyone else lands on their personal [page](./dashboard) at `/app/me`.

### How SAML users map to Chat

Standup rosters are keyed by Google Chat user ids. A SAML assertion carries
an email, which AsyncUp links to the Chat id via the Directory integration
(instant) or the cached email from the person's first bot interaction. Until
one of those happens, `/app/me` shows a "not linked yet" note.

## SCIM provisioning

AsyncUp serves a SCIM 2.0 Users endpoint at `/scim/v2` for IdPs that push
provisioning — Okta, Entra, OneLogin.

> **Google Workspace cannot push SCIM to custom apps** — its auto-provisioning
> only covers pre-integrated catalog apps. Pure Google Workspace installs
> should use the Directory integration instead; SCIM is for orgs whose IdP
> fronts Google.

Setup: generate the **SCIM provisioning token** (Settings → Access tokens),
then configure your IdP with base URL `https://<your-host>/scim/v2` and the
token as the bearer credential. Supported: `ServiceProviderConfig`, list
(`startIndex`/`count`, max 200), get by id, the `userName eq "…"` filter
(dedupe — other filters answer 501), create, PUT/PATCH updates,
deactivate/delete. While no token exists the endpoints answer 404.

What provisioning does:

- **Create/update** registers the user and links them to their Chat identity
  (via the Directory, by email).
- **Deactivate (or delete)** removes the person from **every standup
  roster** — offboarding in the IdP actually offboards them here.
- Reactivating does not restore rosters; an admin adds them back with
  `add @user` when they return.

Adding people to specific standups stays an admin action (`add @user` or the
dashboard) — SCIM has no standup concept, and pushing every provisioned user
into every standup would be wrong more often than right.
