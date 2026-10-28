# Roles and permissions

Everything in AsyncUp asks for one **permission**: the web app, the
[JSON API](./api), Chat commands and [MCP](./mcp) tools. A **role** is a named
set of permissions. A person holds a role either **across the workspace** or
**on one standup**. Their access is everything their roles give them, added
together.

## Where access comes from

| Source | What the person gets | Where it applies |
| --- | --- | --- |
| Google Workspace admin (through the [Directory](./directory)), or the SAML admin group | Admin | The workspace |
| The operator token (`OPERATOR_TOKEN`), while token sign-in is on | Admin | The workspace |
| On a standup's roster | Member | That standup |
| A standup's admin: ran `setup`, created it, `admin @user`, or made a manager on the Team page | Manager | That standup |
| A grant, by email | The granted role, built-in or custom | The workspace, or one standup |

## Built-in roles

| Role | For | Granted? |
| --- | --- | --- |
| **Admin** | Running the install: every standup, workspace settings, sign-in, tokens and roles | Across the workspace only |
| **Manager** | Running standups: settings, people, schedules and blockers | Across the workspace or on one standup |
| **Viewer** | Stakeholders who read but change nothing: answers, blockers, reports, the team, CSV export | Across the workspace or on one standup |
| **Member** | Answering: everyone on a roster has it on that standup | No, it comes from the roster |

Built-in roles can't be changed. Copy one to start a custom role.

## Permissions

| Permission | Lets you | Admin | Manager | Viewer | Member |
| --- | --- | --- | --- | --- | --- |
| `standups.view` | See a standup, who is on it and how today is going | ✓ | ✓ | ✓ | ✓ |
| `answers.view` | Read each day's answers | ✓ | ✓ | ✓ | ✓ |
| `moods.comments` | Read why people chose their mood, without names where moods are anonymous | ✓ | | | |
| `blockers.view` | See blockers and their updates | ✓ | ✓ | ✓ | ✓ |
| `reports.view` | See run history and insights | ✓ | ✓ | ✓ | ✓ |
| `people.view` | See the Team directory | ✓ | ✓ | ✓ | |
| `export` | Download answers as CSV | ✓ | ✓ | ✓ | |
| `standups.configure` | Change the schedule, questions, mood, escalation and webhook; run now, nudge, close polls; send polls with questions and read their results | ✓ | ✓ | | |
| `standups.archive` | Archive a standup and bring it back | ✓ | ✓ | | |
| `people.manage` | Add and remove people, mark them required, make managers, grant roles on the standup | ✓ | ✓ | | |
| `schedules.manage` | Change people's days and days off on the standup, decide time-off requests | ✓ | ✓ | | |
| `blockers.manage` | Resolve anyone's blocker | ✓ | ✓ | | |
| `standups.create` | Create standups | ✓ | | | |
| `standups.delete` | Delete an archived standup with its history | ✓ | | | |
| `settings.manage` | Workspace settings, setup checks, deleting history | ✓ | | | |
| `sso.manage` | Google sign-in, SAML and token sign-in | ✓ | | | |
| `tokens.manage` | Machine tokens, service MCP tokens, everyone's MCP tokens | ✓ | | | |
| `roles.manage` | Create roles, grant them across the workspace, and set the SAML admin group | ✓ | | | |

The last six are **workspace-only**: they mean nothing on a single standup.
Some things don't need a permission. People always answer, skip and manage
their own days off (within the time-off policy), the owner and tagged people work a blocker, and anonymous
moods stay anonymous for every role. Mood never appears in the Chat space, and
everyone sees their own mood comment.

## Custom roles

A custom role is a name, a description and any set of the permissions above.
Good uses:

- **Auditor:** `answers.view`, `reports.view` and `export`, across the
  workspace, for someone who reviews but never runs a standup.
- **Coach:** `schedules.manage` and `blockers.manage` on one standup, for a
  scrum master who isn't its manager.
- **Help desk:** `tokens.manage` and `sso.manage`, for IT without the rest of
  Admin.

## Rules

| Rule | Why |
| --- | --- |
| You can only put permissions you hold into a role, and only grant or revoke a role whose permissions you hold at that scope | Nobody can hand themselves or others more than they have |
| Granting across the workspace needs `roles.manage`. On one standup, `people.manage` there is enough | Managers can bring in a Viewer for their own standup |
| A role with a workspace-only permission can only be granted across the workspace | Those permissions have no meaning on one standup |
| A custom role with any standup permission also gets `standups.view` | The others work on a standup the holder can see |
| You can't revoke or edit away your own `roles.manage` | Someone else, or the operator token, has to. Admins through Google or SAML are never locked out |
| A role that anyone holds can't be deleted | Revoke its grants first |

Grants follow a person's **email**. Google and SAML sign-ins carry it. In
Chat it's the email AsyncUp has learned for that person, from the
[Directory](./directory) or their first message to the app. Changes apply on
the person's next request.

## Managing roles

| Where | What you can do |
| --- | --- |
| Web app: **Settings › Roles** | See every role, its permissions and who holds it. Copy a role, build one from the permission checklist, edit or delete custom roles |
| Web app: **Settings › Access** | See every grant and filter it by role. Grant a role across the workspace or on one standup, revoke, and read the change history |
| Web app: a standup's **Settings › Roles on this standup** | Its managers grant and revoke roles on that standup |
| Chat: `role @user <role>` | Grant a role on the space's standup. `role @user remove <role>` revokes it, and `roles` lists who holds what there. An email works in place of the mention |
| [JSON API](./api#roles-and-grants) | `/permissions`, `/roles`, `/grants` and `/roles/audit` |

Every change to a role or grant is logged with who made it and when.

`admin @user` in Chat, and **Make manager** on the Team page, still make
someone one of the standup's admins. That gives them Manager there, and
`status` lists them as its admins. Use a grant for access without being named
as an admin.

A **reporting manager** set under **Settings → People** is not a role. It lets
someone who manages a standup decide one person's day-off requests on another
standup that needs approval, with no other access there
([Personal schedules](./schedules)).

## What each person sees

- **Web app.** Navigation, settings sections, standup tabs and every button
  follow the person's permissions. A Viewer gets Standups, Blockers, Reports
  and Team, with no Run now, roster or settings controls. Members get their
  own page at `/app/me`.
- **Chat.** Commands that change a standup need the permission in the
  [command reference](./commands). `status`, `trends`, `blockers`,
  `blocker`, polls, `export` and `help` are open to everyone in the space.
- **MCP.** A personal token acts as its owner with their current roles. It's
  only offered the tools those roles could use somewhere, and each call is
  checked again for the standup it names.
- **API.** Each route in the OpenAPI document names its permission in
  `x-permission`. `GET /api/v1/me` lists the caller's permissions across the
  workspace and per standup.

## Notes

- A standup always keeps at least one admin; removing the last is refused.
- A standup created with no admins (for example from a script with the
  operator token) is open to configuration by anyone in its space. Name an
  admin when creating on someone's behalf.
- Who may mark someone away is set per standup by its
  [time-off policy](./schedules#who-can-change-what-the-time-off-policy).
- In the web app, creating a standup goes through the setup walkthrough, so it
  needs `settings.manage` as well as `standups.create`. The API needs only
  `standups.create`.
