# AsyncUp

[![CI](https://github.com/asyncup-dev/asyncup/actions/workflows/ci.yml/badge.svg)](https://github.com/asyncup-dev/asyncup/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Open-source, self-hosted async daily standups for Google Chat.**
No meetings, no SaaS, no telemetry — one small container you run yourself, forever free.

Every workday AsyncUp DMs each participant a card; one tap opens a form with four questions:

1. What did you do yesterday?
2. What will you do today?
3. Any blockers?
4. How is your mood today? (😄 🙂 😐 😕 😫)

Each answer is posted as one card per person under a **per-date thread** in your team space. At the deadline AsyncUp posts a wrap-up: how many mandatory participants submitted, and **who didn't**.

```
📅 Daily Standup — Wed, 10 Jun 2026          (thread parent)
 ├─ 😄 Alice   Yesterday: … Today: … Blockers: ✅ None
 ├─ 🙂 Bob     Yesterday: … Today: … Blockers: ⚠️ Waiting on API keys
 └─ 📊 wrap-up: ✅ 7/9 mandatory submitted · ❌ Missing: Asha, Rohit
```

**Docs: [Getting started](docs/guide/getting-started.md) · [Google Chat setup](docs/guide/google-chat-setup.md) · [Commands](docs/guide/commands.md) · [Configuration](docs/guide/configuration.md) · [Deployment](docs/guide/deployment.md)**

## Features

- **Dialog form, not a chat interrogation** — all four questions in one modal, one submit.
- **Mandatory vs optional participants** — the report counts only who you choose.
- **Per-participant timezones** — prompts go out at 09:30 *their* time.
- **Reminder nudge** before the deadline for people who haven't submitted.
- **Late submissions** still post to the thread, flagged as late.
- **Lightweight forever** — one container, SQLite inside, scale-to-zero friendly (`/tick` + free-tier cron ≈ $0/month).
- **Restart-safe** — all scheduling state lives in SQLite; ticks are idempotent.
- **Platform-agnostic core** — Google Chat is an adapter; Slack and Teams are planned.

## Quickstart

Prereq: a one-time Google Chat app configuration (~15 min) — see
**[docs/guide/google-chat-setup.md](docs/guide/google-chat-setup.md)**.

```bash
cp .env.example .env       # fill in GOOGLE_CHAT_AUDIENCE, mount your service account key
docker compose up -d
```

Expose `POST /chat/events` via HTTPS, point the Chat app at it, then in your team space:

```
@AsyncUp setup Engineering
@AsyncUp add @Alice @Bob @Carol
@AsyncUp optional @Carol
@AsyncUp deadline 11:30
@AsyncUp status
```

Full command and configuration reference in the [docs](docs/guide/commands.md).

## Development

```bash
npm install
npm test                   # vitest unit suite (<1s)
ADAPTER=fake npm run dev   # run without Google credentials
npm run docs:dev           # docs site locally
```

Architecture: `src/core` (domain, scheduler, commands — no platform code),
`src/adapters/gchat` (cards, event routing, API calls), `src/db` (SQLite repo).
Adding a platform means implementing the `ChatAdapter` interface in
[src/core/adapter.ts](src/core/adapter.ts) — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- OOO/vacation awareness (Google Calendar) and "skip today"
- Pre-fill "yesterday" from your previous "today"
- Custom questions, multiple standups per space, edit submissions
- Mood trends, blocker tracking, weekly digest, CSV export
- **Slack adapter**, then **Microsoft Teams**
- **AI features, bring your own key** — opt-in LLM summaries and team insights using your own API key; nothing leaves your infra otherwise

## Contributing

PRs welcome! Read [CONTRIBUTING.md](CONTRIBUTING.md) to get going.
Please also see the [Code of Conduct](CODE_OF_CONDUCT.md) and [Security policy](SECURITY.md).

## License

[MIT](LICENSE)
