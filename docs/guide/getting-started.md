# Getting started

AsyncUp asks every participant a few questions in a Google Chat DM each
workday: by default yesterday, today, blockers and a mood. Answers post as one
card per person under a per-date thread in your team space. At the deadline a
wrap-up names who answered and who didn't.

This page is the map. Follow the **Set up** pages in order and you go from an
empty server to a working standup.

## What you need

| | Why |
| --- | --- |
| A Google Workspace domain, and a Workspace admin who can help | The Chat app, its visibility and the optional admin roles are set in your Workspace |
| A Google Cloud project you own | It holds the Chat app registration and a service account. Billing is not required |
| A small Linux server, or a container platform, with a public HTTPS URL | Google Chat only delivers events to `https://` endpoints |
| A domain or subdomain for that URL | Used as `HOST` throughout these docs, e.g. `standup.example.com` |

## The setup path

| Step | Page | You end with | Time |
| --- | --- | --- | --- |
| 1 | [Host](./server-setup) | AsyncUp running at `https://HOST`, `/healthz` answering | 20–40 min |
| 2 | [Google Cloud and the Chat app](./google-chat-setup) | A Cloud project, a service-account key, and a Chat app pointing at `https://HOST/chat/events` | 15–20 min |
| 3 | [Guided setup and first test](./first-standup) | The web app's guided setup finished, and a test standup that ran in a private space | 15 min |
| 4 | [Roll out to your team](./distribution) | Everyone on the standup can receive the bot's DMs | 5 min to an hour |
| 5 | [Directory and group rosters](./directory) *(optional)* | Rosters that follow a Google Group; admins recognised automatically | 15 min plus up to 15 min for Google to apply the role |
| 6 | [Sign-in](./enterprise-sso) *(optional, recommended)* | Google or SAML sign-in, so people stop needing the operator token | 10–20 min |
| 7 | [Operations](./operations) | Upgrades with a backup, token rotation, monitoring | Read once |

Budget about an hour and a half for steps 1 to 3 the first time, most of it in
the Google Cloud and Admin consoles. Steps 2 and 3 are also walked through
inside the web app at `https://HOST/app/setup`, with a live check at each gate.

## Try it without Google

The `fake` adapter logs every message to the console instead of calling Google
Chat. Useful for a look at the commands, or for development:

```bash
bun install
ADAPTER=fake bun run dev
curl -s -X POST localhost:8080/chat/events \
  -H 'Content-Type: application/json' \
  -d '{"type":"MESSAGE","space":{"name":"spaces/demo","type":"ROOM"},"message":{"argumentText":" setup Demo"}}'
```

## Where to go next

- **Running standups:** the [web app](./web-app), [commands](./commands) and
  [personal schedules](./schedules).
- **Answering them:** the [user guide](./user-guide). Share it with your team.
- **Looking something up:** [configuration](./configuration),
  [roles](./roles), the [JSON API](./api) and [Claude Code and MCP](./mcp).
