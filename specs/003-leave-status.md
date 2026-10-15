# 003: Leave shown in Chat and Calendar

| | |
| --- | --- |
| Status | Draft |
| Size | Cross-cutting (migration, new Google scopes, settings) |
| Figma | [Specs › 003 Leave in Chat and Calendar](https://www.figma.com/design/OQfcL61rbaGakS2FjBKasI?node-id=154-26) |
| PR | — |

## Problem

When someone marks days off in AsyncUp, only AsyncUp knows. Teammates
who message them in Chat or invite them to meetings don't see that they
are away, so they wait for replies that won't come. People end up
setting a Chat status and a Calendar out-of-office by hand, as well as
in AsyncUp.

## User stories

- As someone going on leave, I want my Chat status and calendar to show
  it, without setting them by hand.
- As a teammate, I want to see in Chat that someone is on leave and
  when they're back, before I message them.
- As a manager who marks someone away, I want their Chat status and
  calendar to show it too.
- As a Workspace admin, I want this to be off until I have granted
  AsyncUp the access it needs.

## Acceptance criteria

The setting

1. Settings › General has **Leave in Chat and Calendar**, off by
   default. Its hint names the two scopes to add to the service
   account's domain-wide delegation.
2. With it on, **Decline invites during leave** chooses what the
   out-of-office event does with clashing invites: *Decline nothing*
   (the default), *Decline new invites*, or *Decline all clashes*.
3. With the setting off, AsyncUp writes nothing to Chat or Calendar.
   Turning it off leaves what is already there to expire on its own.

What counts as leave

4. Leave belongs to the person, not to a standup. One status and one
   out-of-office event cover them however many standups they're on.
5. Dated days off count once they are active: set by the person under
   a self-service policy, set by a manager, or approved. Pending,
   declined and withdrawn days don't count.
6. Days off a few days apart count as one period when the days between
   are days the person doesn't work anyway, such as a weekend. Friday
   and Monday off is one period, Friday to Monday.
7. Vacation mode counts when it is on for every standup the person is
   on, which is what My standups › Vacation mode does.

Chat status

8. On the first day of a dated period, in the person's timezone, their
   Chat custom status becomes 🌴 "On leave until Mon 20 Oct" (the last
   day off). It expires at the end of that day. It replaces any status
   they had, which isn't restored.
9. When vacation mode is switched on, their status becomes 🌴 "On
   leave" with no expiry. When it is switched off, the status is
   cleared if it is still the one AsyncUp set.
10. When a period changes (a day added, cancelled or approved), the
    status is updated, or cleared if the period is gone and the status
    is still the one AsyncUp set.

Calendar out-of-office

11. When a dated period becomes active, AsyncUp adds an "On leave"
    out-of-office event to the person's primary calendar, from 00:00
    on the first day to 00:00 after the last day, in their timezone.
    The declining follows the setting, with the message "I'm on leave
    until Mon 20 Oct."
12. When the period changes, the event's times are updated. When it is
    cancelled, the event is deleted.
13. Vacation mode adds no Calendar event: it has no end date.

Telling people

14. When someone marks days off, or a manager marks them or approves
    their request, the confirmation adds: "Your Chat status and
    calendar will show it." (or "Their…" for a manager).
15. When writing to Chat or Calendar fails, for example a missing
    scope or no known email for the person, it is retried with the
    hourly roster check, and Settings › General shows the latest
    failure with the person and when.

## Non-goals

- Changing Active, Away or Do not disturb. Only the custom status.
- Restoring the status someone had before their leave.
- A per-person opt-out. The workspace setting decides.
- Reading Chat statuses or Calendar events back into AsyncUp, beyond
  today's out-of-office check.
- Leave on one standup only (a manager's `vacation @user` in one
  space). That pauses the standup, not the person.

## Design impact

| Area | Change |
| --- | --- |
| Web app | Settings › General: **Leave in Chat and Calendar** switch, **Decline invites during leave** select, and the latest failure |
| Chat cards and dialogs | The replies to `off …`, `vacation`, a manager marking someone away, and an approval gain one line saying Chat and Calendar will show it, when the setting is on |
| API and OpenAPI | `WorkspaceSettings` gains `leaveInChat: boolean`, `leaveDeclineMode: 'none' \| 'new' \| 'all'` and `leaveSyncError: { message, at } \| null` |
| MCP | None |
| Database | Migration 19 adds `leave_presence`: one row per person per period, with the dates, the Calendar event ID, whether the status is set, and the last error |
| Permissions | None. The setting needs `settings.manage`, like the rest of Settings › General |
| Docs | `directory.md` (the two scopes and the switch), `schedules.md` (what people and teammates see), `web-app.md` (Settings › General), `api.md` (the settings fields) |
| Website | `site/index.html` "People and schedules": leave shows in Chat and Calendar |
| Google APIs and scopes | Two new scopes on the service account's domain-wide delegation: `https://www.googleapis.com/auth/chat.users.availability` and `https://www.googleapis.com/auth/calendar.events` |

How it works:

- A `LeavePresence` service works out each person's periods from their
  active days off, their personal week and their vacation mode. It
  compares them with the `leave_presence` rows, and makes Chat and
  Calendar match. It runs for that person when their days off or
  vacation change, and for everyone with the hourly roster check. That
  hourly run sets statuses whose first day has come, and retries
  failures. It is idempotent, so a restart never writes twice.
- Chat: `users.availability.patch` with `updateMask=customStatus`, as
  the person, through domain-wide delegation. Clearing reads the status
  first (`users.availability.get`) and clears it only if the text is
  still ours.
- Calendar: `events.insert` with `eventType: "outOfOffice"` on the
  person's primary calendar, then `events.patch` or `events.delete`
  with the stored ID. Google doesn't allow all-day out-of-office
  events, so the event runs midnight to midnight.
- The person's timezone is their own, if set, otherwise their first
  standup's. Their email comes from the Directory or from their first
  use of the bot, as for today's out-of-office check.

Failure cases: the scopes aren't delegated (Google answers 401 or 403),
the person has no known email, their Workspace edition has no custom
status, or Calendar refuses the event. Each is logged, kept on the row,
shown in Settings › General and retried hourly. Failures never block
setting days off.

Checked in Google's docs on 15 Oct 2026:
- Chat custom status is set with `users.availability.patch`, scope
  `chat.users.availability`, with user authentication only. It needs a
  Business or Enterprise edition.
- Domain-wide delegation counts as user authentication for the Chat
  API. Only the `chat.bot` and `chat.app.*` scopes are barred from it.
  The docs don't confirm it for this method, so it needs a test against
  a real Workspace before release.
- Out-of-office events need `eventType: "outOfOffice"`, can't be
  all-day, and live on the primary calendar only.

## Open questions

None. Decided with the maintainer on 15 Oct 2026:

- Custom status and an out-of-office event; Active and Away are left
  alone.
- Dated days off and vacation mode both count. Vacation mode gets a
  status with no expiry and no Calendar event.
- Leave is per person, not per standup.
- The leave status replaces the person's own status.
- Invites: a workspace setting, *Decline nothing* by default.
- One workspace switch; no personal opt-out.
