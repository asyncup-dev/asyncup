# Roles and permissions

| Role | How you get it | What it grants |
| --- | --- | --- |
| Operator | Holds the operator token (`OPERATOR_TOKEN`) | Everything, including workspace settings, while token sign-in is on |
| Workspace admin | A Google Workspace super or delegated admin (through the [Directory](./directory)), in the SAML admin group, or granted Admin | The full console: every standup, workspace settings, deleting archived standups |
| Manager (standup admin) | Ran `setup`, created the standup in the web app, was granted `admin @user`, or granted Manager | Configure that standup from Chat or the web app; manage the schedules and time-off requests of people on it |
| Viewer | Granted Viewer, on one standup or across the workspace | Read standups, answers, blockers and reports, see the team, and export. No changes |
| Custom role | Granted a role your admins made | The permissions that role holds |
| Participant | On the standup's roster: picked in the People grid, `add @user`, or a member of the Google Group it follows | Answer, edit, skip, DM self-service, their own page at `/app/me` |
| Everyone in the space | — | `status`, `trends`, `blockers`, `blocker`, polls, `help`, and `setup` |

## Permissions

Every check in the web app, the [JSON API](./api), Chat commands and
[MCP](./mcp) asks for one permission, either across the workspace or on one
standup. The roles above are fixed sets of them:

| Permission | Lets you | Admin | Manager | Viewer | Participant |
| --- | --- | --- | --- | --- | --- |
| `standups.view` | See a standup, who is on it and how today is going | ✓ | ✓ | ✓ | ✓ |
| `answers.view` | Read each day's answers | ✓ | ✓ | ✓ | ✓ |
| `blockers.view` | See blockers and their updates | ✓ | ✓ | ✓ | ✓ |
| `reports.view` | See run history and insights | ✓ | ✓ | ✓ | ✓ |
| `people.view` | See the Team directory | ✓ | ✓ | ✓ | |
| `export` | Download answers as CSV | ✓ | ✓ | ✓ | |
| `standups.configure` | Change the schedule, questions, mood, escalation and webhook; run now, nudge, close polls | ✓ | ✓ | | |
| `standups.archive` | Archive a standup and bring it back | ✓ | ✓ | | |
| `people.manage` | Add and remove people, mark them required, make managers | ✓ | ✓ | | |
| `schedules.manage` | Change people's weeks and days off, decide time-off requests | ✓ | ✓ | | |
| `blockers.manage` | Resolve anyone's blocker | ✓ | ✓ | | |
| `standups.create` | Create standups from the web app or API | ✓ | | | |
| `standups.delete` | Delete an archived standup with its history | ✓ | | | |
| `settings.manage` | Workspace settings, setup checks, deleting history | ✓ | | | |
| `sso.manage` | Google sign-in, SAML and token sign-in | ✓ | | | |
| `tokens.manage` | Machine tokens, service MCP tokens, everyone's MCP tokens | ✓ | | | |
| `roles.manage` | Create roles, grant them, and set the SAML admin group | ✓ | | | |

A participant's permissions apply only to their own standups, and a
manager's to the standups they manage. The API reference names the
permission each route needs. Anonymous moods stay anonymous for every role.

## Custom roles and grants

A **custom role** is a name and a set of the permissions above. A **grant**
gives a role to someone, by email, either across the workspace or on one
standup. Built-in roles (Admin, Manager, Viewer, Member) can't be changed;
Member comes from being on a roster, so it isn't granted.

| Rule | Why |
| --- | --- |
| You can only put permissions you hold into a role, and only grant or revoke a role whose permissions you hold at that scope | Nobody can hand themselves or others more than they have |
| Granting across the workspace needs `roles.manage`. On one standup, managing its people (`people.manage`) is enough | Managers can bring in a Viewer for their own standup |
| A role with a workspace-only permission can only be granted across the workspace | Those permissions have no meaning on one standup |
| A custom role with any standup permission also gets `standups.view` | The others work on a standup the holder can see |
| You can't revoke or edit away your own `roles.manage` | Someone else, or the operator token, has to. Admins through Google or SAML are never locked out |
| A role that anyone holds can't be deleted | Revoke its grants first |

Grants follow a person's email. Google and SAML sign-ins carry it, and in
Chat it's the email AsyncUp has learned for that person (from the
[Directory](./directory) or their first interaction). Changes apply on the
next request; an MCP token follows its owner's roles as they are now.

Every change to a role or grant is logged with who made it and when. Manage
them through the [JSON API](./api): `GET /api/v1/permissions`,
`/api/v1/roles`, `/api/v1/grants` and `GET /api/v1/roles/audit`.

Notes:

- A standup always keeps at least one admin; removing the last is refused.
- A standup created with no admins (for example from a script with the
  operator token) is open to configuration by anyone in its space. Name an
  admin when creating on someone's behalf.
- The web app and the [JSON API](./api) share one authorisation model. MCP
  tools act as the token's owner and see exactly what that person sees
  ([Claude Code and MCP](./mcp)).
- Who may mark someone away is set per standup by its
  [time-off policy](./schedules#who-can-change-what-the-time-off-policy).
