# 5. Directory and group rosters

Step 5 of the [setup path](./getting-started), optional. AsyncUp can read your
Workspace directory as its service account. That buys three things:

| Feature | What it needs |
| --- | --- |
| **Rosters that follow a Google Group**: joiners are added, leavers dropped | The admin role below |
| **Google Groups in a space**: on a roster picked from the space, members of a group in the space count as in it | The admin role below |
| **User lookups**: Workspace admins recognised at Google sign-in, accounts outside the Workspace refused, SAML and SCIM users linked to their Chat identity straight away, emails found for Calendar out-of-office | The admin role below |
| **Calendar out-of-office**: people with an *Out of office* event are marked away | [Domain-wide delegation](#calendar-ooo) |
| **Leave in Chat and Calendar**: days off and vacation mode shown as a Chat status and an out-of-office event | [Domain-wide delegation](#leave-in-chat) |

No domain-wide delegation is needed for the first two. Google recommends an
admin role on the service account instead, and that is what AsyncUp uses.

## Give the service account an admin role {#admin-role}

You need a Workspace super admin for this, once.

1. In the Google Cloud project that holds the service account, enable the
   **Admin SDK API** (**APIs & Services → Library**).
2. In the [Admin console](https://admin.google.com), go to **Account → Admin
   roles → Create new role**. Name it, e.g. *AsyncUp Directory Reader*.
3. Under **Admin API privileges**, tick only **Groups › Read** and
   **Users › Read**. Nothing else.
4. Open the new role and choose **Assign service accounts**. Enter the service
   account's email, e.g. `asyncup@<project>.iam.gserviceaccount.com`. Assign it
   to the service account, not to a person: AsyncUp calls Google as the service
   account.

The built-in **Groups Reader** role is not enough on its own. It has no
**Users › Read**, which AsyncUp needs to resolve group members and look people
up.

A new role can take up to about 15 minutes to apply. Until then:

- a roster sync says it can't read the group, and names the role to grant;
- Google sign-in still works, but everyone signs in as a regular user, and the
  server log says the service account can't read users.

## Rosters that follow a Google Group

A standup can follow a Google Group instead of people picked from its space.
Everyone in the group is on the standup, including members of nested groups.

- **When you create a standup**: under **People**, set **Who is on it** to
  *Everyone in a Google Group* and enter the **Google Group email**.
- **For an existing standup**: **Settings → People → Roster**, choose
  *Everyone in a Google Group*, enter the group's email and save.

The roster syncs straight away, then every hour, again in the hour before each
run, and before **Run now**. **Sync now** syncs on demand and reports who was
added, who was removed, and who was skipped and why: people outside your
Workspace, suspended accounts and accounts that aren't active.

How a group roster behaves:

| Event | Result |
| --- | --- |
| Someone joins the group | Added with the default setup: prompted, required, following the standup's days |
| Someone leaves the group | Dropped from the standup. Their history stays |
| You untick someone in the People grid | They stay off, even though they're still in the group |
| You add someone by hand who isn't in the group | They stay on |

Group joiners are not checked for whether the bot can DM them. Make sure the
app reaches everyone in the group ([step 4](./distribution)).

## Rosters picked from the space {#space-rosters}

A roster picked from the space is checked against the space on the same
schedule: every hour, and again in the hour before each run.

| Event | Result |
| --- | --- |
| Someone on the roster leaves the space | Taken off the standup, and out of today's run unless they've answered. Their history stays |
| They rejoin the space | Put back with their old settings, from the next run |
| You take someone off by hand | They stay off, even if they rejoin |
| Someone was added from outside the space (API or MCP) | Never taken off, because they were never seen in the space |
| Someone joins the space | Nothing. You pick who is on the standup |

When a Google Group is a member of the space, its people count as in the
space. AsyncUp reads the group with the admin role above. If it can't, or
Google Chat doesn't answer, or the space lists nobody, nobody is taken off and
**Settings → People → Last sync** says why.

The first check after an upgrade only notes who is in the space, so nobody
comes off until they leave after that.

## User lookups

With a service-account key stored, AsyncUp looks people up as the service
account:

| Where | Effect |
| --- | --- |
| Google sign-in | Accounts the Directory doesn't know are refused, suspended accounts are refused, and Workspace super or delegated admins get the admin console |
| SAML sign-in | The person is linked to their Chat identity on first sign-in, and Workspace admins get the admin console. Accounts the Directory doesn't know are still let in: the IdP vouched for them |
| SCIM provisioning | New users are linked to their Chat identity by email |
| Calendar out-of-office | People's emails are found before they have ever used the bot |

If the service account can't read users, every one of these falls back to
working without the Directory: Google sign-in lets the person in as a regular
user, and SAML users are linked the first time they use the bot.

### Directory through delegation (legacy)

**Settings › Google Chat → Directory through delegation (legacy)** sets a
**Workspace admin to act as**, which moves Directory lookups from the admin role
to domain-wide delegation, impersonating that admin. Leave it **off** with the
admin role in place.

Earlier versions needed delegation for lookups, and installs set up that way
keep working. If you deliberately want lookups through delegation, turn it on,
enter an admin's email, and delegate
`https://www.googleapis.com/auth/admin.directory.user.readonly` to the service
account (see the steps below). Calendar out-of-office never uses this setting or
the admin email.

## Calendar out-of-office {#calendar-ooo}

This needs **domain-wide delegation**, because AsyncUp reads each person's
calendar as that person. It does not use the Workspace admin email.

1. Find the service account's **OAuth 2 client ID**, a long number. It is shown
   as *Client ID for domain-wide delegation* under **Settings › Google Chat →
   Service account**, in the guided setup when you switch Calendar
   out-of-office on, and in the Cloud console on the service account's page.
2. In the Admin console: **Security → Access and data control → API controls →
   Domain-wide delegation → Add new**. Enter the client ID and the scope
   `https://www.googleapis.com/auth/calendar.events.readonly`.
3. Enable the **Google Calendar API** in the Cloud project.
4. In AsyncUp, switch **Calendar out-of-office** on: in the guided setup's
   service-account step, or under **Settings › General**.

The setting is off in a new install. Turn it on only after delegating: without
the delegation, every calendar check fails, nobody is marked away, and each
failure is logged.

When a run opens, people with an *Out of office* event that day are marked
away, listed under *Away* and never counted as missing. AsyncUp needs each
person's email to check their calendar: it comes from the Directory (the admin
role above), or is learned the first time the person uses the bot.

## Leave in Chat and Calendar {#leave-in-chat}

AsyncUp sets each person's Chat custom status and adds an out-of-office event
to their calendar, as that person. Google only lets a user change their own
status, so this needs **domain-wide delegation** too.

1. In the Admin console: **Security → Access and data control → API controls →
   Domain-wide delegation**. Edit the service account's entry (or add one with
   its client ID) and add both scopes:
   `https://www.googleapis.com/auth/chat.users.availability` and
   `https://www.googleapis.com/auth/calendar.events`.
2. Enable the **Google Calendar API** in the Cloud project. The Chat API is
   already on.
3. In AsyncUp, switch **Leave in Chat and Calendar** on under **Settings →
   General**.

Keep any scopes already on the entry, such as the Calendar read scope above:
Google replaces the list you save. Custom statuses need a Business or
Enterprise edition. What people see is described in
[Personal schedules](./schedules#leave-in-chat).
