---
layout: home

hero:
  name: AsyncUp
  text: Async daily standups for Google Chat
  tagline: Open source. Self-hosted. Your data, your keys, your database — no meeting required.
  image:
    src: /logo.svg
    alt: AsyncUp
  actions:
    - theme: brand
      text: Get started →
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/asyncup-dev/asyncup

features:
  - icon: 💬
    title: One-tap standups
    details: A DM card opens a four-question form — yesterday, today, blockers, mood. Edit until the deadline; the posted card updates in place.
  - icon: 🧵
    title: Tidy date threads
    details: Every answer lands as one card per person under the day's thread. The wrap-up posts the count and exactly who's missing.
  - icon: 🏖️
    title: Away-aware
    details: Skip-today button, vacation mode, and automatic Google Calendar OOO sync — away people are never nagged or counted as missing.
  - icon: ⚠️
    title: Blockers that follow up
    details: Blockers open from answers, auto-resolve on the next clean submission, and escalate to a contact when they go stale.
  - icon: 📊
    title: Insights built in
    details: Mood trends, weekly digests, anonymous team-mood mode, CSV export, and a token-gated web dashboard for config and history.
  - icon: 🤖
    title: AI summaries, your key
    details: Opt-in daily TL;DR and week-in-review via your own Anthropic or OpenAI key. Nothing leaves your infra otherwise.
  - icon: 🪶
    title: Lightweight forever
    details: One ~300 MB container on 1 vCPU / 512 MB. Embedded SQLite by default — or bring your own PostgreSQL with one env var.
  - icon: 🔌
    title: Platform-agnostic core
    details: Google Chat today; Slack and Microsoft Teams adapters are next on the roadmap. MIT licensed, never SaaS.
---

<div class="au-section">
  <h2>How a morning works</h2>
  <p class="au-sub">No meeting, no interrogation bot — one card, one form, one thread.</p>
  <div class="au-steps">
    <div class="au-step">
      <span class="num">1</span>
      <h3>The bot DMs your team</h3>
      <p>At 09:30 in <em>each person's own timezone</em>, everyone gets a card with a <b>Fill standup</b> button — yesterday pre-filled from their last "today". One gentle reminder before the deadline.</p>
    </div>
    <div class="au-step">
      <span class="num">2</span>
      <h3>Answers thread up neatly</h3>
      <p>Each submission posts as a card under the day's thread in your team space. Re-submit to edit in place. Skips, vacations, and calendar OOO show as away — never as missing.</p>
    </div>
    <div class="au-step">
      <span class="num">3</span>
      <h3>The wrap-up holds the line</h3>
      <p>At the deadline: who submitted, who didn't, open blockers, team mood — plus an optional AI TL;DR and a weekly digest with trends.</p>
    </div>
  </div>
</div>

<div class="au-section">
  <h2>What your team space sees</h2>
  <p class="au-sub">A real thread from a Wednesday.</p>
  <div class="au-thread">
    <div class="day">📅 Daily Standup — Wed, 11 Jun</div>
    <div class="au-msg">
      <div class="avatar">😄</div>
      <div class="bubble">
        <div class="who">Asha</div>
        <div class="q">Yesterday</div>
        Shipped the payments retry queue
        <div class="q">Today</div>
        Start on the invoice exports
        <div class="q">Blockers</div>
        ✅ None
      </div>
    </div>
    <div class="au-msg">
      <div class="avatar">😐</div>
      <div class="bubble">
        <div class="who">Rohit <small>· edited</small></div>
        <div class="q">Yesterday</div>
        Auth refactor review rounds
        <div class="q">Today</div>
        Land it, then pick up the flaky e2e
        <div class="q">Blockers</div>
        <span class="blocked">⚠️ Waiting on staging API keys (2d)</span>
      </div>
    </div>
    <div class="au-wrapup">
      📊 Wrap-up &nbsp;·&nbsp; ✅ 7/8 submitted &nbsp;·&nbsp; ❌ Missing: Dev &nbsp;·&nbsp; 🏖️ Away: Mei &nbsp;·&nbsp; ⚠️ 1 open blocker
    </div>
  </div>
</div>

<div class="au-section au-compare">
  <h2>Why self-host AsyncUp?</h2>
  <p class="au-sub">Hosted standup bots charge per user per month and hold your team's daily history.</p>

| | **AsyncUp** | Hosted standup bots |
|---|---|---|
| Cost | $0 forever — MIT licensed | Per user, per month |
| Your standup history | In **your** SQLite file or Postgres | On their servers |
| AI features | Bring your own key, opt-in per standup | Their model, their terms |
| Infrastructure | One small container, scale-to-zero friendly | — |
| Customization | Questions, schedules, escalation, dashboard — and the source code | What the plan allows |

</div>

<div class="au-cta">
  <h2>Up and running in 15 minutes</h2>
  <a class="button" href="/guide/getting-started">Read the guide</a>
  <span class="alt"><code>docker compose up -d</code> — amd64 &amp; arm64 images on GHCR</span>
</div>
