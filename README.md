<p align="center">
  <img src="docs/public/logo.svg" alt="AsyncUp" width="96" height="96">
</p>

<h1 align="center">AsyncUp</h1>

<p align="center">
  <a href="https://github.com/asyncup-dev/asyncup/actions/workflows/ci.yml"><img src="https://github.com/asyncup-dev/asyncup/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://asyncup-dev.github.io/asyncup/"><img src="https://img.shields.io/badge/docs-asyncup--dev.github.io-15435f" alt="Docs"></a>
</p>

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

**Docs: [Getting started](docs/guide/getting-started.md) · [Google Chat setup](docs/guide/google-chat-setup.md) · [Commands](docs/guide/commands.md) · [Configuration](docs/guide/configuration.md) · [AI summaries](docs/guide/ai.md) · [Deployment](docs/guide/deployment.md)**

## Features

- **Dialog form, not a chat interrogation** — all questions in one modal, one submit. **Edit until the deadline**; the posted card updates in place.
- **Custom questions** per standup (`questions set …`), with the mood dropdown toggleable.
- **Mandatory vs optional participants** — the report counts only who you choose.
- **Vacation & skip** — DM `vacation`/`back` for yourself, a 🏖️ *Skip today* button on every prompt; away people aren't nagged or counted as missing. Optional **Google Calendar OOO sync** marks people away automatically.
- **Pre-fill** — "yesterday" starts as your previous "today".
- **Per-participant timezones** — prompts go out at 09:30 *their* time, reminder nudge before the deadline, late submissions flagged.
- **Blocker tracking, collaboration & escalation** — blockers open automatically from answers and can be **worked as items**: tag teammates (interactive DM card with Acknowledge / Update / Resolve), updates broadcast to everyone involved + a per-blocker thread, daily nudges until acknowledged, and escalation DMs when they go stale. Untagged blockers auto-resolve on the next clean submission; tagged ones need an explicit resolve.
- **Anonymous mood** (`mood anon`) — cards hide who felt what; the wrap-up shows the team average.
- **Web dashboard** — token-gated, server-rendered config + history UI baked into the same container (`DASHBOARD_TOKEN`).
- **Insights** — `trends` (participation + mood over 4 weeks), weekly digest (`digest on`), CSV export endpoint.
- **AI summaries, bring your own key** — opt-in daily TL;DR and week-in-review via your Anthropic/OpenAI key; nothing leaves your infra otherwise.
- **Team admins & multiple standups per space** — config restricted to admins; address standups by `#id`.
- **Lightweight forever** — one container, SQLite inside (auto-migrating schema), scale-to-zero friendly (`/tick` + free-tier cron ≈ $0/month). Runs happily on 1 vCPU / 512 MB.
- **Bring your own database** — set `DATABASE_URL` and AsyncUp uses your PostgreSQL (managed or `docker compose --profile postgres`) instead of embedded SQLite; both engines tested in CI.
- **Restart-safe** — all scheduling state lives in SQLite; ticks are idempotent.
- **Platform-agnostic core** — Google Chat is an adapter; Slack and Teams are planned.

## Quickstart

Prereq: a one-time Google Chat app configuration (~15 min) — see
**[docs/guide/google-chat-setup.md](docs/guide/google-chat-setup.md)**.

```bash
cp .env.example .env       # fill in GOOGLE_CHAT_AUDIENCE, mount your service account key
docker compose up -d       # pulls ghcr.io/asyncup-dev/asyncup (amd64 + arm64)
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

- **Slack adapter**, then **Microsoft Teams**

## Contributing

PRs welcome! Read [CONTRIBUTING.md](CONTRIBUTING.md) to get going.
Please also see the [Code of Conduct](CODE_OF_CONDUCT.md) and [Security policy](SECURITY.md).

## License

[MIT](LICENSE)
