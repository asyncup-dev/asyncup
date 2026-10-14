# Claude Code and MCP

AsyncUp has no AI of its own. Instead it speaks the
[Model Context Protocol](https://modelcontextprotocol.io) at `/mcp`, so an
assistant your team already uses can read standups and, with the right
scopes, act as a person: answer today's standup, chase a blocker, mark a day
off or nudge the team.

It is built and tested for **Claude Code**. Cursor, VS Code and any other
client that can send a bearer token header work the same way. Claude.ai and
ChatGPT connectors need OAuth sign-in, which AsyncUp does not offer yet.

## 1. Switch it on

An admin turns the server on under **Settings › MCP server** and picks the
default scopes new tokens get (read-only unless changed). While it is off,
`/mcp` answers `503 mcp_disabled`.

## 2. Create a token

On the same page, **New token**:

- A **personal** token acts as you. It sees what you see in the web app and
  writes as you. Anyone signed in can make one.
- A **service** token needs the `tokens.manage` permission. It is read-only
  and sees the whole workspace.
  Use it for reports and dashboards, not for acting as a person.

Pick only the scopes the assistant needs:

| Scope | Tools |
| --- | --- |
| `read` | `get_me`, `list_standups`, `get_standup`, `get_my_standups`, `list_runs`, `get_run`, `list_blockers`, `get_team`, `get_insights`, `get_schedule`, `list_time_off_requests` |
| `blockers:write` | `acknowledge_blocker`, `update_blocker`, `resolve_blocker` |
| `submit` | `submit_answers` (every answer required, and the mood when the standup asks for one), `skip_today` (takes a one-line `reason`, posted in the day's thread) |
| `schedule` | `update_my_settings` (timezone, vacation), `set_working_days`, `set_days_off`, `cancel_day_off`, `decide_time_off_request` |
| `manage` | `run_standup_now`, `nudge_standup` — only on standups you manage |

The token is shown once. Copy it before closing the panel.

## 3. Connect Claude Code

For yourself, in every project:

```sh
claude mcp add --transport http --scope user asyncup https://asyncup.example.com/mcp \
  --header "Authorization: Bearer amcp_…"
```

For a team repo, commit a `.mcp.json` that keeps the token out of the file,
and have each person export their own:

```json
{
  "mcpServers": {
    "asyncup": {
      "type": "http",
      "url": "https://asyncup.example.com/mcp",
      "headers": { "Authorization": "Bearer ${ASYNCUP_TOKEN}" }
    }
  }
}
```

```sh
export ASYNCUP_TOKEN=amcp_…
```

The **Connect a client** panel on the MCP settings page fills in your
server's URL and, right after you create a token, the token itself.

Check it with `claude mcp list`, or `/mcp` inside a session. Then ask:

- "Who on Platform hasn't posted today? Nudge them."
- "Summarise this week's blockers across my standups."
- "Answer today's standup: yesterday I shipped the export fix, today I'm on
  the billing webhooks, no blockers."
- "Mark me off Friday, comp off for the weekend release."

## How the tools behave

Every tool has a title, the four MCP hints and an output schema, so Claude
Code can tell reads from writes and ask before anything that changes state.
Read tools are read-only and never contact anyone. Every write may message
people in Google Chat, so writes are marked as open-world.

Results come back as structured JSON in the same shapes as the
[JSON API](./api), described by its OpenAPI document. A refusal (no such
standup, not your blocker, the time-off policy says no) is an error result
with a plain sentence the model can act on, not a protocol failure.

Tools see exactly what the token's owner sees, with the owner's current
[roles](./roles): a member sees their own standups, a manager the standups
they run, an admin everything. A token is only offered the tools its owner's
permissions could use somewhere. A Viewer's token has no `run_standup_now`
tool, for example. Each call is checked again for the standup it names.
Anonymous moods stay anonymous.

## Security

- Tokens are stored hashed, expire 90 days after their last use, and can be
  revoked from the settings page at any time.
- Requests that carry an `Origin` header are refused with `403`. MCP clients
  never send one, so a web page cannot reach the endpoint through a visitor's
  browser.
- `/mcp` shares the 60 requests a minute per IP limit with the other
  credential endpoints.
- Every call is logged with the token, the tool, a short summary of the
  arguments and whether it worked, under **Recent activity**.

## Troubleshooting

| Answer | Meaning |
| --- | --- |
| `503 mcp_disabled` | The server is switched off — see step 1 |
| `401` | The token is missing, unknown, revoked or expired; the message says which |
| `403` | The request carried an `Origin` header — it came from a browser, not an MCP client |
| A tool is missing | The token lacks its scope, or (for `submit_answers` and `skip_today`) the server runs without the standup service |
