# Commands

Configure AsyncUp by @mentioning it in the space where reports post.
Anyone in the space can run commands (role restrictions are on the roadmap).

| Command | Effect |
| --- | --- |
| `setup [name]` | Create a standup reporting to this space |
| `add @user…` | Add participants (mandatory by default) |
| `remove @user…` | Remove participants |
| `mandatory @user…` | Count these people in the wrap-up report |
| `optional @user…` | They get prompts, but don't count toward the report |
| `time HH:MM` | When the prompt DM goes out — interpreted in each participant's own timezone |
| `deadline HH:MM` | When the run closes and the wrap-up posts — in the standup timezone |
| `remind <minutes>` | Nudge non-submitters this many minutes before the deadline (`0` disables) |
| `timezone <IANA>` | Standup timezone, e.g. `Asia/Kolkata`, `Europe/Berlin` |
| `days mon,tue,…` | Which days the standup runs (default `mon–fri`) |
| `status` | Show configuration and today's progress |
| `help` | List all commands |

## Notes

- **Late submissions** after the deadline still post to the thread, marked
  *late*; the wrap-up isn't recalculated.
- **Roster snapshots:** the day's roster is frozen when the run opens.
  `add`/`remove` apply from the next run.
- **Resubmissions** aren't allowed — one update per person per day (edit
  support is on the roadmap).
