# Roles and permissions

| Role | How you get it | What it grants |
| --- | --- | --- |
| Operator | Holds the operator token (`OPERATOR_TOKEN`) | Everything, including workspace settings, while token sign-in is on |
| Workspace admin | A Google Workspace super or delegated admin (through the [Directory](./directory)), or in the SAML admin group | The full console: every standup, workspace settings, deleting archived standups |
| Manager (standup admin) | Ran `setup`, created the standup in the web app, or was granted `admin @user` | Configure that standup from Chat or the web app; manage the schedules and time-off requests of people on it |
| Participant | On the standup's roster: picked in the People grid, `add @user`, or a member of the Google Group it follows | Answer, edit, skip, DM self-service, their own page at `/app/me` |
| Everyone in the space | — | `status`, `trends`, `blockers`, `blocker`, polls, `help`, and `setup` |

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
