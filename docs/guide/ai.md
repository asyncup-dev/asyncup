# AI summaries (bring your own key)

AsyncUp can post an **AI TL;DR** under each day's thread and an **AI week in
review** with the weekly digest. This is strictly opt-in, twice:

1. The self-hoster adds an LLM key in the dashboard (below). Without it,
   nothing ever leaves your infrastructure.
2. A standup admin enables it per standup with `ai on`.

## Configuration

Dashboard → **Settings → AI summaries**: pick the provider (Anthropic or
OpenAI), paste your API key (stored encrypted), optionally set the model
(Anthropic defaults to `claude-opus-4-7`; OpenAI requires an explicit model).
Saving applies immediately.

The integration uses plain HTTPS calls (no SDK dependency) and only ever sends
the standup submissions of standups that have `ai on`. Failures are logged and
never block the run from closing.

## What gets generated

- **Daily** (`ai on`): a 3–5 bullet TL;DR of the day's submissions — themes,
  progress, risks, blockers needing attention — posted in the day's thread
  after the wrap-up.
- **Weekly** (`ai on` + `digest on`): a short "week in review" appended to the
  weekly digest.

## Cost & model notes

A daily summary for a 10-person team is roughly 1–2k input tokens — a few
cents per day even on the most capable models. Set a smaller model
(e.g. `claude-haiku-4-5`) in Settings if you want it near-free.

## Privacy considerations

Standup answers are sent to your chosen LLM provider for the enabled standups.
Tell your team before enabling it, and prefer framing AI output as *team*
insights — AsyncUp's summaries are designed around themes and blockers, not
per-person performance scoring.
