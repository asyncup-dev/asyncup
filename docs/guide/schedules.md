# Personal schedules

Most people work the standup's days. Some don't: a four-day week, a
Tuesday-to-Saturday rota, an ad hoc contractor, or just a comp-off after a
weekend release. Personal schedules keep those people from being prompted
on days they don't work — and from being counted as missing.

## Two building blocks

**A person's days** on a standup. The standup's own days are the default,
and anyone can be given different days, including days the standup doesn't
run for everyone else. Days belong to one standup: someone on two standups
can work Monday to Friday on one and Wednesday to Sunday on the other.

| Setting | Meaning |
| --- | --- |
| Follow the standup (default) | Expected on the standup's days, and on any it adds later |
| Custom days, e.g. `mon-thu` or `wed-sun` | Expected only on those days, whichever they are |
| Ad hoc | No fixed days — expected only on dates marked *working* |

New people, whether they join a group roster or are added by hand, follow
the standup's days.

**Dated overrides** mark single days or ranges as *off* or *working*, with a
short reason. Comp-off after a weekend shift is an *off* override on the
weekday; an ad hoc person marks their *working* days. Both can be set ahead.

When a run opens, someone is expected only if the date is a working day for
them and not overridden off. On the standup's own days, everyone else starts
the run as **away** with a reason — day off, not a working day, vacation, or
calendar out-of-office — gets no prompt, is not counted as missing, and shows
under *Away* on the overview and in reports.

On any other day, the standup runs only if someone on it works that day: their
own days include it, or they marked it *working*. That run, at the usual
times, is just for them. Nobody else is prompted, listed as away or counted.
The weekly digest still posts after the standup's last day, so answers from a
Saturday or Sunday after it show in that week's Insights rather than in the
digest already posted. Days off and *working* days are per person, so a
*working* Saturday opens a Saturday run on every standup they are on.

## From Chat

DM the bot:

| Message | Effect |
| --- | --- |
| `off tomorrow comp off` | Tomorrow off, with a reason |
| `off 22 sep to 24 sep sick` | A range off (up to 31 days — longer absences use `vacation`) |
| `working sat` | An extra working day (ad hoc people use this for every day they work) |
| `off list` | What's coming up, with each entry's status |
| `off cancel <date>` | Withdraw an entry |
| `days mon-thu` · `days adhoc` · `days reset` | Your days on your standup, or back to its days. On several standups, the bot asks which and replies with the command for each, such as `days #12 mon-thu` |

Dates read naturally: `today`, `tomorrow`, a weekday name (the next one), `19 sep`,
`sep 19`, `2026-09-19`. A date without a year means the coming one unless it is
under three months back, so `2 jan` in December is next January. Only managers
can change days in the past.

Managers, in the team space with an @mention of someone on that standup:

| Command | Effect |
| --- | --- |
| `off @Asha tomorrow dentist` / `working @Asha sat` | Mark someone away or working |
| `off @Asha cancel <date>` | Undo it |
| `days @Asha tue-sat` | Someone's days on this standup only (`days mon,tue` without a mention still sets the standup's days) |

The person is DM'd every time a manager changes their schedule, with the
one-word reply that undoes it.

## From the console

- **Standup → Settings → People**: a grid with everyone in the standup's
  space, or everyone in the Google Group it follows
  ([group rosters](./directory#rosters-that-follow-a-google-group)). Per
  person, tick whether they are on the standup, whether they are required, and
  which days they work on it. The standup's days are marked *default*; any
  other day can be ticked too. Each row says *Default* or *Custom*, with
  *Reset to default*, and each tick saves straight away and shows *Saved*.
  Ticking exactly the standup's days puts the person back on the default. The
  create form uses the same grid, with everyone in the space ticked to start
  with.
- **Team → Edit schedule** on any person: their days on each standup you
  manage, the overrides list with who set each one, an add row, and *Mark
  away today*.
- **My page → My schedule**: your days on each standup, the same controls,
  plus *Off today* and *Off tomorrow*.
- **Standup → Overview**: the *Away* group under today's run, with reason chips.
- **Standup → Settings → Time off**: the policy below.

## Who can change what: the time-off policy

One setting per standup, under *Settings › Schedule*. A manager is an admin of
a standup the person is on; managers and workspace admins can mark that person
away or working in every mode.

A person changing their own days off is bound by the policy of every standup
they are on and don't administer. Someone who runs one team and sits on
another still needs the other team's approval. Days belong to one standup, so
changing them is bound by that standup's policy only.

| Policy | A person marking themselves | Managers hear about it |
| --- | --- | --- |
| **Self-service** (default) | Applies immediately | A digest DM of the day's self-service changes when the run closes |
| **Needs approval** | Becomes a request | A DM card with **Approve** / **Decline**, and the *Requests* tab under Team |
| **Managers only** | Refused with a pointer to the managers | — |

Under *Needs approval*, the first of the person's managers to act wins;
workspace admins can act on any request, and nobody decides their own.
Declining asks for a one-line reason, which is sent to the person. A request
unanswered by the deadline of a standup that needs approval lapses — the
person counts as expected for that run and is told so.

| A person under *Needs approval* or *Managers only* | Allowed? |
| --- | --- |
| Changing their days on that standup | No — there is no request for days, so its managers set them |
| Asking again for a day that is already approved | Yes — only the reason changes |
| Asking for the opposite of an approved day | No — ask a manager |
| Withdrawing a pending request, or giving back a day off | Yes |
| Dropping a working day a manager set | No |

Every change records who made it, when, and through which channel. Reports
count an approved or manager-set away day as excused, never as missing; a
declined or lapsed request counts as missing. A manager changing a past day
corrects that day's run, except for people who submitted. Each standup's
managers get the digest of a change once, whichever team's run closes first.

## Leave in Chat and Calendar {#leave-in-chat}

With **Settings → General → Leave in Chat and Calendar** on, people's leave
shows where their teammates look. It belongs to the person, not a standup:
one status and one event, however many standups they're on.

| Leave | Chat custom status | Calendar |
| --- | --- | --- |
| Days off (set, or approved) | 🌴 *On leave until Mon 20 Oct* from the first day, expiring after the last | An *On leave* out-of-office event on their primary calendar, 00:00 on the first day to 00:00 after the last, in their timezone |
| Vacation mode, on every standup | 🌴 *On leave*, until they switch it off | Nothing: there is no end date |

- Days off a few days apart are one period when the days between are days
  they don't work, such as a weekend.
- Pending, declined and withdrawn days don't count.
- The status replaces whatever status they had, which isn't restored.
- When days change, the status and event follow. When they're cancelled,
  both go, but a status the person has since changed is left alone.
- **Decline invites during leave** sets what the event does with clashing
  invites: nothing (the default), new invites only, or all clashes. Declines
  say *I'm on leave until Mon 20 Oct.*
- The replies to `off`, `vacation` and `back`, and a manager's approval, say
  that Chat and Calendar will show it.
- When Google refuses, for example a missing scope or an unknown email, the
  latest failure shows under **Settings → General** and is retried hourly.

It needs two scopes on the service account's domain-wide delegation; see
[Directory and group rosters](./directory#leave-in-chat). Google allows custom
statuses on Business and Enterprise editions.

## Integrations

Webhooks receive two more events: `schedule_change` (person, summary, who,
channel) and `time_off_request` (person, dates, working, reason, request ids).
A change to someone's days goes to that standup's webhook and digest only.
The JSON API exposes the same controls under `/me/schedule`, `/me/overrides`,
`/people/:userName/schedule`, `/people/:userName/overrides` and `/requests`
— see [JSON API](./api). MCP tokens with the `schedule` scope get
`set_working_days`, `set_days_off`, `cancel_day_off`,
`decide_time_off_request` and `update_my_settings`; `get_schedule` and
`list_time_off_requests` come with `read` — see [Claude Code and MCP](./mcp).
Tools act as the token's owner under the same policy.
