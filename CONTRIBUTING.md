# Contributing to AsyncUp

Thanks for your interest! AsyncUp is an open-source, self-hosted async standup
bot — contributions of all sizes are welcome.

## Development setup

```bash
git clone https://github.com/asyncup-dev/asyncup
cd asyncup
npm install
npm test               # unit tests (vitest)
ADAPTER=fake npm run dev   # run locally without Google credentials
```

The `fake` adapter logs every DM/post to the console, so you can exercise the
full lifecycle (commands, scheduler, dialogs) with `curl` against
`POST /chat/events` — see `tests/events.test.ts` for example payloads.

## Architecture in 30 seconds

```
src/core       domain types, scheduler, commands, StandupService — platform-agnostic
src/adapters   ChatAdapter implementations (gchat today; slack/teams welcome!)
src/db         SQLite repository (better-sqlite3)
src/server.ts  Express webhook + /tick + /healthz
```

Two rules keep the codebase healthy:

1. **No platform types in `src/core`.** The core only talks to the
   `ChatAdapter` interface (`src/core/adapter.ts`). If your change makes the
   core import anything Google-specific, it belongs in an adapter.
2. **All scheduling state lives in the DB.** Ticks must stay idempotent —
   the process can crash and restart at any time without double-sending.

## Adding a platform adapter (Slack, Teams, …)

Implement `ChatAdapter` in `src/adapters/<platform>/`, add an event
translation layer that maps platform webhooks onto `CommandHandler` and
`StandupService`, and wire it into `src/index.ts` behind the `ADAPTER` env
var. Open an issue first so we can agree on scope — happy to guide.

## Pull requests

- Keep PRs focused; small is beautiful.
- `npm run typecheck && npm test` must pass.
- Add tests for behavior changes (the suite runs in <1s, no excuses 🙂).
- For user-visible changes, update the docs in `docs/`.

## Reporting bugs / proposing features

Use the issue templates. For security issues see [SECURITY.md](SECURITY.md) —
please don't open public issues for vulnerabilities.

## License

By contributing you agree your contributions are licensed under the
[MIT License](LICENSE).
