# 002: Space membership sync

| | |
| --- | --- |
| Status | Done |
| Size | Cross-cutting (migration, API change) |
| Figma | [Specs › 002 Space membership sync](https://www.figma.com/design/OQfcL61rbaGakS2FjBKasI?node-id=148-23) |
| PR | [#102](https://github.com/asyncup-dev/asyncup/pull/102) |

## Problem

When a standup's roster is picked from its Chat space, people stay on it
after they leave the space. They keep getting prompts, count as missing
in the wrap-up, and their answers post into a space they can no longer
read. Rosters that follow a Google Group already drop leavers. Rosters
picked from the space should do the same.

## User stories

- As a manager, I want people who leave the space to come off the
  standup by themselves, so that the wrap-up only counts the real team.
- As someone who left a space, I don't want to keep getting prompts for
  a team I'm no longer part of.
- As a manager, I want someone who rejoins the space to be back on the
  standup with their old settings, without setting them up again.
- As a manager, I want to see who came off and why, and to check now
  rather than wait for the next hourly check.

## Acceptance criteria

The check

1. Given a standup whose roster is picked from the space, the check
   runs on the same schedule as group rosters: hourly, and again in the
   hour before the run opens.
2. When the check runs, everyone on the roster who is in the space is
   marked as seen in the space.
3. Given someone on the roster who was seen in the space and is no
   longer in it, then they come off the standup. Their answers and
   history are kept.
4. Given someone on the roster who has never been seen in the space
   (added through the API or MCP from outside it), then the check never
   takes them off.
5. Given someone taken off for leaving who has not answered today's open
   run, then they leave that run too, as group leavers do. If they have
   answered, their answer stays.
6. Given someone the check took off rejoins the space, then the next
   check puts them back with their old settings (mandatory, timezone,
   personal week). They are prompted from the next run.
7. Given someone a manager took off by hand, then rejoining the space
   does not put them back.
8. Given a standup whose roster follows a Google Group, then leaving or
   joining the space changes nothing. The group decides, as today.

Groups in the space

9. Given the space includes a Google Group as a member, then the check
   reads that group's members with the same reader group rosters use,
   and counts them as in the space.
10. Given that group can't be read, then the check takes nobody off that
    time, still puts back people listed in the space directly, and
    records why, naming the group.

Failure and safety

11. Given Google Chat doesn't answer, or the app is no longer in the
    space, then the check changes nothing and records the error.
12. Given the space lists no people at all, then the check takes nobody
    off and records "The space listed no members, so nobody was taken
    off."

Seeing it

13. Given a standup picked from the space, then Settings › People shows
    a "Last sync" row with when the space was last checked, a **Sync
    now** button and the last error, as group rosters do. The Roster
    hint says people who leave the space come off and come back if
    they rejoin.
14. Given people are off because they left the space, then the same
    row lists them with the date each left, until they rejoin or are
    added again by hand.
15. When a manager presses **Sync now**, then the result says who was
    taken off and who was put back, or "Already up to date."
16. `POST /standups/{id}/roster/sync` works for rosters picked from the
    space, with the same response as for group rosters. It no longer
    returns `409 no_roster_group`. It needs `people.manage`, as today.
17. `GET /standups/{id}` returns `roster.leftSpace`: the people off
    because they left, with the date each left. `roster.syncedAt` and
    `roster.error` cover space checks too.

## Non-goals

- Adding people who join the space. A roster picked from the space
  stays hand-picked; only leavers come off and only they come back.
- Posting in the space or messaging managers when someone comes off.
- Changing group rosters, or how SCIM offboarding works.
- Reacting to Chat membership events in real time. The hourly check is
  enough, and needs no new subscription or scope.
- Invited people who haven't joined the space yet. They aren't members
  until they join, so they are never marked as seen.

## Design impact

| Area | Change |
| --- | --- |
| Web app | Standup › Settings › People: the Roster hint, and a "Last sync" row for rosters picked from the space, with **Sync now**, the last error, the people off because they left, and the result of a sync |
| Chat cards and dialogs | None |
| API and OpenAPI | `POST /standups/{id}/roster/sync` covers space rosters, and no longer returns `409 no_roster_group`. `StandupDetail.roster` gains `leftSpace: { userName, displayName, at }[]` |
| MCP | None. `get_standup` returns `roster.leftSpace` through `StandupDetail` |
| Database | Migration 18 adds `participants.in_space INTEGER NOT NULL DEFAULT 0` and `participants.left_space_at TEXT NULL`, in both dialects |
| Permissions | None |
| Docs | `web-app.md` (Settings › People), `directory.md` (rosters and groups in a space), `api.md` (the sync route and `leftSpace`), `handbook.md` if it describes leavers |
| Website | `site/index.html` "People and schedules": rosters that follow a Google Group or the Chat space |
| Google APIs and scopes | None new. `spaces.members.list` with app authentication, as the roster picker uses today. Reading a group in the space needs the Admin SDK role group rosters already need |

How it works:

- `RosterSync.sync` takes either source. With a roster group it does
  what it does today. Without one, it lists the space's human members
  with `showGroups` on, expands each Google Group member with the
  existing group reader, and compares against the roster.
- Each roster row gets two fields. `in_space` is set once the person is
  seen in the space. `left_space_at` is set when the check takes them
  off. Only rows with `in_space` set can come off. Only rows with
  `left_space_at` set come back when the person reappears.
- Taking someone off by hand (web, API, Chat `remove`) clears
  `left_space_at`, so rejoining doesn't bring them back. Adding them
  by hand clears it too.
- The check reuses `roster_synced_at` and `roster_sync_error`, so one
  "Last sync" row and one schedule cover both sources.
- The first check after this ships only marks who is in the space. It
  takes nobody off, because nobody has been seen before.

Failure cases: the Chat API errors, the app was removed from the
space, a group in the space can't be read, or the space lists nobody.
In each case nobody comes off, and the error shows in Settings.

Not yet confirmed against a real Workspace: Chat names a group member
`groups/{id}` (a Cloud Identity group), and the check passes that ID to
the Admin SDK, which accepts a group's unique ID as the group key.
Google's docs (checked 15 Oct 2026) don't say the two IDs are the same.
If they aren't, the group can't be read, and criterion 10 keeps everyone
on and says why in Settings.

## Open questions

None. Decided with the maintainer on 15 Oct 2026:

- Only people seen in the space and then gone come off. People added
  from outside the space are never touched.
- Group rosters are unaffected; the group decides.
- Someone the check took off comes back automatically if they rejoin.
  Anyone removed by hand stays off.
- A Google Group in the space is read with the group reader. If it
  can't be read, nobody comes off and Settings says why.
