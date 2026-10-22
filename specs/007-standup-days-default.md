# 007: Standup days are a default, and people's days are per standup

| | |
| --- | --- |
| Status | Done |
| Size | Cross-cutting (scheduler, API, Chat, web app, no migration) |
| Figma | [Specs › 007 Standup days are a default](https://www.figma.com/design/OQfcL61rbaGakS2FjBKasI?node-id=178-73) |
| PR | Link once opened |

## Problem

A standup's days are a hard limit. A standup that runs Monday to Friday
can't prompt someone who works Wednesday to Sunday: their Saturday and
Sunday boxes are greyed out, and the scheduler never opens a run on
those days. The only way round it is to add Saturday and Sunday to the
standup, which then prompts everyone who follows the standup, and every
new joiner, seven days a week. Separately, a person's days are one week
shared by every standup they're on, so working weekends on one team
changes their days on every other team. Each change in the People table
also saves at once, with nothing to say it did, so people look for a
Save button.

## User stories

- As a standup manager, I want the standup's days to be the default,
  so new people start with them.
- As a standup manager, I want to give one person any days of the week
  on my standup, including days the rest of the team doesn't work.
- As someone on two standups, I want my days on one to leave the other
  alone.
- As anyone changing days, I want to see that the change saved.

## Acceptance criteria

Defaults and per-standup days

1. A standup's days are the default for everyone on it who hasn't been
   given their own days, including group joiners and people added by
   hand. Changing the standup's days changes theirs.
2. A person's days on one standup never change their days on another.
3. A person's days can be any of the seven days, including days outside
   the standup's own.

Running

4. On one of the standup's days, the run opens as today. Everyone on
   the default is prompted, and so is anyone whose own days include
   that day; the others are off, as today.
5. On a day outside the standup's days, a run opens at the usual times
   when at least one active person on the standup has that day in their
   own days, or an active `working <date>` override for that date.
   Only those people are prompted and reminded.
6. On such a day nobody else is on the run: they aren't prompted, aren't
   listed as away in the wrap-up, and aren't counted in participation.
7. When nobody is expected on a day, no run opens.
8. Runs on extra days behave like any other run: wrap-up, late answers,
   edit requests, blockers and webhooks.
9. The weekly digest still posts after the standup's last default day.
   Answers from an extra day after it count in that week's Insights, not
   in the digest already posted.

People table (standup settings and the create form)

10. Anyone with `schedules.manage` on the standup can tick any day for
    anyone on it. The change applies to this standup only.
11. The standup's days are marked as the default in the header. A person
    on the default shows "Default"; a person with their own days shows
    "Custom" and a **Reset to default** action.
12. Ticking exactly the standup's days puts the person back on the
    default, so later changes to the standup's days reach them.
13. Each change shows "Saved" beside the row, or the error. There is no
    Save button.
14. The note under the table says days apply to this standup only.

Setting your own days

15. My schedule lists each standup the person is on, with their days on
    it. Each can follow the standup, have custom days, or be ad hoc.
16. Team › Edit schedule lists the person's standups that the manager
    manages, the same way.
17. In a DM, `days mon-thu` sets the person's only standup. On several,
    it changes nothing and replies with one line per standup, such as
    "`days #12 mon-thu` for Developers". `days #12 mon-thu` sets that
    standup.
18. In a space, `days @Asha tue-sat` sets this standup only.
19. Changing your own days is refused only when that standup's time-off
    policy isn't self-service. Other standups' policies don't apply.
20. Replies, the DM to the person when a manager changes their days, the
    managers' digest and the `schedule_change` webhook name the one
    standup changed.

API and MCP

21. `PATCH /me/schedule` and `PATCH /people/:userName/schedule` accept an
    optional `standupId`. With it, only that standup changes, and setting
    someone else's days needs `schedules.manage` on that standup.
    Without it, every standup changes, as today. That form is kept for
    existing integrations and documented as deprecated.
22. `GET /me/schedule` and `GET /people/:userName/schedule` add
    `standups`: each standup's id, name, days, the person's
    `workingDays` and its label. The top-level `workingDays` stays, and
    is deprecated.
23. MCP `set_working_days` and `get_schedule` take and return the same.
24. The Team list shows a person's days when they match on every
    standup the viewer can see, otherwise "Varies by standup".

## Non-goals

- Per-standup dated overrides and vacation. They stay per person,
  across all their standups.
- Different prompt or deadline times on a person's extra days.
- Setting every standup at once from Chat or the web app.
- Changing when the weekly digest posts.

## Design impact

| Area | Change |
| --- | --- |
| Web app | People table in standup settings and the create form: every day can be ticked, default days marked in the header, Default/Custom per row, **Reset to default**, "Saved" per row, new note. My schedule and the Edit schedule drawer list one row of days per standup. Team list shows "Varies by standup" |
| Chat cards and dialogs | None. Text replies only: `days` in a DM and in a space, and the DM to a person whose days a manager changed |
| API and OpenAPI | `WorkingDaysBody` gains optional `standupId`. `Schedule` gains `standups`. Top-level `workingDays` on `Schedule` and the all-standups `PATCH` are marked deprecated. The `schedule_change` webhook is sent for the one standup changed |
| MCP | `set_working_days` takes optional `standupId`; `get_schedule` returns `standups` |
| Database | None. `participants.working_days` is already stored per standup. Today's values, copied to every standup, become each standup's starting value |
| Permissions | None new. Setting someone's days on a standup needs `schedules.manage` on that standup |
| Docs | `schedules.md` (defaults, per-standup days, extra days), `web-app.md` (People table, My schedule), `commands.md` (`days` in a DM and a space), `api.md` (`standupId`, `standups`, deprecations), `mcp.md`, `user-guide.md` |
| Website | None. "personal weeks" in `site/index.html` still holds |
| Google APIs and scopes | None |

How it works:

- `dayStatus` takes the standup's days. A person on the default
  (`working_days` null) is expected only on them; custom days, ad hoc
  and overrides work as today.
- The scheduler's weekday check (`src/core/scheduler.ts:113`) becomes
  "is anyone on this standup expected today", using `dayStatus` and
  today's active overrides. On a day outside the standup's days, the run
  is created with only the people expected, which covers criterion 6.
- A new repo write sets one person's days on one standup.
  `setWorkingDaysForUser` stays only for the deprecated all-standups
  `PATCH`.
- `ScheduleService.setWorkingDays` takes a standup, judges the policy of
  that standup only, and applies the change to that standup's run today,
  in that standup's timezone. Today it uses the first standup's
  timezone for all of them.
- The People table saves a week equal to the standup's days as
  "follow" (`reset`).
- Leave presence already reads each standup's own value
  (`src/core/leave-presence.ts:192`), so it needs no change.

## Open questions

None. Decided with the maintainer on 22 Oct 2026:

- A person's days are set per standup, not once for all their standups.
- Every way of setting days changes one standup: the People table, `days`
  in Chat, My schedule, Team › Edit schedule, the API and MCP.

Proposed in this spec and approved with it:

- Ticking exactly the standup's days puts a person back on the default
  (criterion 12).
- The API keeps its all-standups form, deprecated, so existing
  integrations don't break (criterion 21).
- Dated overrides and vacation stay per person (Non-goals).
- On an extra day, only the people expected are on the run (criterion 6).
