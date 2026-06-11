# Commands

Configure AsyncUp by @mentioning it in the space where reports post.
When a space has **several standups**, prefix commands with the standup id,
e.g. `@AsyncUp #2 time 09:30` — `status` lists all standups with their ids.

## Configuration (admins only)

The person who runs `setup` becomes the standup's first admin. Only admins can
change configuration; `status`, `trends`, `blockers`, `export` and `help` are
open to everyone in the space.

| Command | Effect |
| --- | --- |
| `setup [name]` | Create a standup reporting to this space (creator becomes admin) |
| `add @user…` | Add participants (mandatory by default) |
| `remove @user…` | Remove participants |
| `mandatory @user…` / `optional @user…` | Count toward the wrap-up report, or not |
| `vacation @user…` / `back @user…` | Mark people away — no prompts, not counted as missing |
| `admin @user…` / `unadmin @user…` | Manage who can change configuration |
| `time HH:MM` | Prompt time — interpreted in each participant's own timezone |
| `deadline HH:MM` | When the run closes and the wrap-up posts — standup timezone |
| `remind <minutes>` | Nudge non-submitters this many minutes before the deadline (`0` disables) |
| `timezone <IANA>` | Standup timezone, e.g. `Asia/Kolkata` |
| `days mon,tue,…` | Which days the standup runs (default `mon–fri`) |
| `questions` | Show the current question list |
| `questions set Q1 \| Q2 \| …` | Replace the questions (1–10, pipe-separated) |
| `questions reset` | Back to the default three questions |
| `mood on\|off` | Toggle the mood dropdown in the form |
| `digest on\|off` | Weekly digest posted after the last run of the week |
| `ai on\|off` | AI daily/weekly summaries (needs an [LLM key](./ai) on the server) |

## Insights (everyone)

| Command | Effect |
| --- | --- |
| `status` | Configuration + today's progress (submitted / pending / away) |
| `trends` | Last 4 weeks: participation % and average mood |
| `blockers` | Open blockers with their age |
| `export` | How to download a CSV of submissions |

## DM self-service

Anyone can DM the bot directly:

| Message | Effect |
| --- | --- |
| `vacation` | Pause prompts for yourself across all your standups |
| `back` | Resume prompts |

## Behavior notes

- **Editing:** re-open *Fill standup* before the deadline to edit — the posted
  card updates in place and is marked *edited*.
- **Skip today:** the prompt card has a 🏖️ *Skip today* button; skipped people
  are listed as away, not missing.
- **Pre-fill:** the "yesterday" answer is pre-filled from your previous
  "today" answer.
- **Late submissions** after the deadline still post, flagged *late*; the
  wrap-up isn't recalculated and late entries can no longer be edited.
- **Blockers** auto-resolve when the same person submits a blocker-free
  standup on a later day.
- **Roster snapshots:** the day's roster is frozen when the run opens;
  `add`/`remove`/`vacation` apply from the next run.
- **Custom questions** apply from the next run. Questions containing the word
  "blocker" get blocker tracking; questions containing "yesterday"/"today"
  get pre-fill behavior.
