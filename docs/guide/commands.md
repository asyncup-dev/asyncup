# Commands

Configure AsyncUp by @mentioning it in the space where reports post.
When a space has **several standups**, prefix commands with the standup id,
e.g. `@AsyncUp #2 time 09:30` — `status` lists all standups with their ids.

`help` shows the essentials; `help all` lists every command.

## Configuration (admins only)

The person who runs `setup` becomes the standup's first admin (`setup` itself
is open to everyone in the space — there is nobody to gate it before the first
standup exists). Only admins can change configuration; `status`, `trends`,
`blockers`, `blocker`, `poll`, `polls`, `export` and `help` are open to
everyone in the space. `status` without a `#id` prefix reports every standup
in the space.

| Command | Effect |
| --- | --- |
| `setup [name]` | Create a standup reporting to this space (creator becomes admin; duplicate names are refused) |
| `run now` | Open today's run immediately and prompt everyone — see the whole flow without waiting for the schedule |
| `archive` | Retire the standup: prompts and reports stop, history stays |
| `add @user…` | Add participants (mandatory by default) |
| `remove @user…` | Remove participants |
| `mandatory @user…` / `optional @user…` | Count toward the wrap-up report, or not |
| `vacation @user…` / `back @user…` | Mark people away — no prompts, not counted as missing |
| `admin @user…` / `unadmin @user…` | Manage who can change configuration |
| `time HH:MM` | Prompt time — interpreted in each participant's own timezone (participants set theirs by DMing `timezone <IANA>`; default is the standup timezone) |
| `deadline HH:MM` | When the run closes and the wrap-up posts — standup timezone |
| `remind <minutes>` | Nudge non-submitters this many minutes before the deadline (`0` disables) |
| `timezone <IANA>` | Standup timezone, e.g. `Asia/Kolkata` |
| `days mon,tue,…` | Which days the standup runs (default `mon–fri`) |
| `questions` | Show the current question list |
| `questions set Q1 \| Q2 \| …` | Replace the questions (1–10, pipe-separated) |
| `questions reset` | Back to the default three questions |
| `mood on\|off\|anon` (also `anonymous`) | Mood dropdown; `anon` hides who felt what — the wrap-up shows the team average instead |
| `escalate @user` | DM this person when blockers stay open too long |
| `escalate days N` / `escalate off` | Escalation threshold (default 2 days) / disable |
| `digest on\|off` | Weekly digest posted after the last run of the week |
| `ai on\|off` | AI daily/weekly summaries (needs an [LLM key](./ai) on the server) |

## Insights (everyone)

| Command | Effect |
| --- | --- |
| `status` | Configuration + today's progress (submitted / pending / away) |
| `trends` | Last 4 weeks: participation % and average mood |
| `blockers` | Open blockers with ids, age, who's tagged, and update counts |
| `export` | How to download a CSV of submissions |

## Working a blocker together (everyone)

Blockers get an id (`blockers` shows them). Tag teammates to pull them in:

| Command | Effect |
| --- | --- |
| `blocker 12 tag @Asha @Rohit` | Tagged people get an interactive DM card (✋ Acknowledge · 📝 Add update · ✅ Resolve) |
| `blocker 12 update <text>` | Post an update — DMed to the reporter and everyone tagged, and added to the blocker's thread in the space |
| `blocker 12 resolve` | Close it (reporter, tagged people, or admins) |

How collaboration changes the lifecycle:

- **Tagging makes it explicit-resolve.** Untagged blockers still auto-resolve
  when the reporter's next standup is blocker-free; once a blocker is tagged
  or has updates, only an explicit resolve closes it — someone's clean
  standup can't silently end a conversation others are having.
- **Acknowledge stops the nudges.** Tagged people get one DM per day (at run
  close) until they hit ✋ Acknowledge; posting an update acknowledges
  implicitly. The reporter is notified of every ack.
- **Everything is tracked.** Updates and resolution land in a per-blocker
  thread in the team space, and open blockers keep appearing in wrap-ups,
  digests, and escalation pings until resolved.

## Polls (everyone)

Quick team decisions without a meeting — a card in the space, one tap to vote:

| Command | Effect |
| --- | --- |
| `poll Question? \| Option A \| Option B` | Post a poll card (2–6 options). Votes update the card live; voting again changes your vote |
| `polls` | List open polls with vote counts |
| `poll <id> results` | Current tallies with voter names |
| `poll <id> close` | Close it and post final results (creator or admin) |

## DM self-service

Anyone can DM the bot directly:

| Message | Effect |
| --- | --- |
| `vacation` (or `ooo`) | Pause prompts for yourself across all your standups |
| `back` | Resume prompts |
| `timezone <IANA>` | Get prompts at the standup's prompt time in *your* timezone (all your standups) |
| `timezone reset` | Follow each standup's timezone again (`timezone` alone shows the current setting) |

## Behavior notes

- **Editing:** re-open *Fill standup* before the deadline to edit — the posted
  card updates in place and is marked *edited*.
- **Skip today:** the prompt card has a 🏖️ *Skip today* button; skipped people
  are listed as away, not missing.
- **Pre-fill:** the "yesterday" answer is pre-filled from your previous
  "today" answer.
- **Late submissions** after the deadline still post, flagged *late*; the
  wrap-up isn't recalculated and late entries can no longer be edited.
- **Untagged blockers** auto-resolve when the same person submits a
  blocker-free standup on a later day; tagged ones need an explicit
  `blocker <id> resolve`. With `escalate @user` configured, the contact gets
  one DM at run close listing every blocker that newly crossed the threshold —
  each blocker is escalated once.
- **Calendar OOO** (when [enabled](./configuration)): participants with an
  *Out of office* event in Google Calendar are automatically marked away for
  that day's run. Emails come from the Directory API when a Workspace admin
  email is configured (works for everyone immediately), otherwise they are
  learned from Chat interactions — kicking in after a person has used the
  bot at least once.
- **Roster snapshots:** the day's roster is frozen when the run opens;
  `add`/`remove`/`vacation` apply from the next run.
- **Custom questions** apply from the next run. Questions containing the word
  "blocker" get blocker tracking; questions containing "yesterday"/"today"
  get pre-fill behavior.
