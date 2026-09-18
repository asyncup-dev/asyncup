# Personal schedules

Most people work the standup's days. Some don't: a four-day week, a
Tuesday-to-Saturday rota, an ad hoc contractor, or just a comp-off after a
weekend release. Personal schedules keep those people from being prompted
on days they don't work — and from being counted as missing.

## Two building blocks

**A personal week** overrides the standup's days for one person:

| Setting | Meaning |
| --- | --- |
| Follow the standup (default) | Expected on every day the standup runs |
| Custom week, e.g. `mon-thu` | Expected only on those weekdays |
| Ad hoc | No fixed days — expected only on dates marked *working* |

**Dated overrides** mark single days or ranges as *off* or *working*, with a
short reason. Comp-off after a weekend shift is an *off* override on the
weekday; an ad hoc person marks their *working* days. Both can be set ahead.

When a run opens, someone is expected only if the date is a working day for
them and not overridden off. Everyone else starts the run as **away** with a
reason — day off, not a working day, vacation, or calendar out-of-office — gets
no prompt, is not counted as missing, and shows under *Away* on the overview
and in reports. A standup still only runs on its own days, so a Saturday
worker is not prompted on Saturday unless the standup itself includes Saturday.

## From Chat

DM the bot:

| Message | Effect |
| --- | --- |
| `off tomorrow comp off` | Tomorrow off, with a reason |
| `off 22 sep to 24 sep sick` | A range off (up to 31 days — longer absences use `vacation`) |
| `working sat` | An extra working day (ad hoc people use this for every day they work) |
| `off list` | What's coming up, with each entry's status |
| `off cancel <date>` | Withdraw an entry |
| `days mon-thu` · `days adhoc` · `days reset` | Your own week, or back to the standup's |

Dates read naturally: `today`, `tomorrow`, a weekday name (the next one), `19 sep`,
`sep 19`, `2026-09-19`. Only managers can change days in the past.

Managers, in the team space with an @mention:

| Command | Effect |
| --- | --- |
| `off @Asha tomorrow dentist` / `working @Asha sat` | Mark someone away or working |
| `off @Asha cancel <date>` | Undo it |
| `days @Asha tue-sat` | Someone's personal week (`days mon,tue` without a mention still sets the standup's days) |

The person is DM'd every time a manager changes their schedule, with the
one-word reply that undoes it.

## From the console

- **Team → Edit schedule** on any person: the week, the overrides list with
  who set each one, an add row, and *Mark away today*.
- **My page → My schedule**: the same controls for yourself, plus *Off today*
  and *Off tomorrow*.
- **Standup → Overview**: the *Away* group under today's run, with reason chips.
- **Standup → Settings → Time off**: the policy below.

## Who can change what: the time-off policy

One setting per standup, under *Settings › Schedule*. Managers can mark
anyone away or working in every mode.

| Policy | A person marking themselves | Managers hear about it |
| --- | --- | --- |
| **Self-service** (default) | Applies immediately | A digest DM of the day's self-service changes when the run closes |
| **Needs approval** | Becomes a request | A DM card with **Approve** / **Decline**, and the *Requests* tab under Team |
| **Managers only** | Refused with a pointer to the managers | — |

Under *Needs approval*, the first manager to act wins; workspace admins can
act on any request. Declining asks for a one-line reason, which is sent to
the person. A request unanswered by the run's deadline lapses — the person
counts as expected for that run and is told so. Personal-week changes apply
immediately under both self-service and approval; only *Managers only*
blocks them.

Every change records who made it, when, and through which channel. Reports
count an approved or manager-set away day as excused, never as missing; a
declined or lapsed request counts as missing.

## Integrations

Webhooks receive two more events: `schedule_change` (person, summary, who,
channel) and `time_off_request` (person, dates, working, reason, request ids).
The JSON API exposes the same controls under `/me/schedule`, `/me/overrides`,
`/people/:userName/schedule`, `/people/:userName/overrides` and `/requests`
— see [JSON API](./api).
