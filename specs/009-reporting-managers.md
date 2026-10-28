# 009: Reporting managers can approve their reports' days off

| | |
| --- | --- |
| Status | Done |
| Size | Cross-cutting (migration, API, permissions, web app) |
| Figma | [Specs › 009 Reporting managers](https://www.figma.com/design/OQfcL61rbaGakS2FjBKasI?node-id=195-136) |
| PR | — |

Proposed by @shrey-CDZ in #113; this spec carries that proposal forward with
the review's fixes.

## Problem

Under the `approval` time-off policy, only workspace admins and the standup's
managers can decide a day-off request. The right approver is often a person's
line manager, who isn't a manager of that standup. Making them one hands over
the whole standup's configuration just to sign off leave. We want a per-standup
reporting manager, picked from people who already manage a standup, who can
approve their reports' days off there.

## User stories

- As a standup manager, I want to set who each person reports to on this
  standup, so the right person signs off their days off.
- As a reporting manager, I want my reports' day-off requests to reach me, and
  to approve or decline them in Chat or the web app.
- As someone on two standups, I want each standup's reporting manager to have a
  say only through that standup.

## Acceptance criteria

Setting a reporting manager

1. Given someone with `people.manage` on a standup, when they pick a person's
   reporting manager in that standup's People table, then it is saved for that
   person on that standup and shown on their row.
2. The picker lists only people who manage at least one active standup.
   Anyone else is refused: "A reporting manager must already be a manager on a
   standup."
3. Nobody can report to themselves: "Someone can't report to themselves."
4. Choosing "None" clears it.
5. It is per standup: the same person can have a different reporting manager
   on each of their standups.
6. Adding someone back to a roster by hand starts them with no reporting
   manager.

Requests and decisions

7. Given a standup on `approval`, when a person asks for a day off, then the
   request card goes to that standup's managers and to the person's reporting
   manager on it, once each.
8. The person's reply names the reporting manager: "📨 Sent to Neha Kapoor and the
   managers of Engineering for approval — …". It stays as today when there is
   no reporting manager or they are already a manager of that standup.
9. A working request (working on a day off) does not go to the reporting
   manager, and they cannot decide it.
10. A reporting manager can decide a day-off request only while both hold:
    they are the person's reporting manager on one of the person's standups
    that uses `approval`, and they still manage at least one active standup.
    Otherwise: "Only Bob's managers can decide this." This holds for the Chat
    card, the web app and the API.
11. A reporting manager on a `self` or `managers` standup gains nothing: they
    don't get the card and can't decide the request.
12. A reporting manager's decision works exactly as a manager's does today:
    the first decision wins, the runs are updated, the person is told, the
    webhook fires, and Calendar and Chat status follow through `LeavePresence`.
13. Team › Requests shows a reporting manager their reports' pending day-off
    requests on the standups from criterion 10, and not their working requests.
14. A reporting manager still can't decide their own request: "Your own
    requests go to your managers."

## Non-goals

- Half-day leave, approval chains, delegates, or one approval per standup.
- Reporting managers changing someone's week or marking them away directly.
- Taking the reporting line from the Google Directory or SCIM.
- MCP tools.

## Design impact

| Area | Change |
| --- | --- |
| Web app | Standup › Settings › People: a **Reports to** column with a picker of managers and **None**, behind `people.manage`. On a phone it is one more line on each person's card. Not shown when creating a standup. Team › Requests is unchanged; it lists more requests for a reporting manager |
| Chat cards and dialogs | No new card. The requester's reply names the reporting manager (criterion 8) |
| API and OpenAPI | `PATCH /standups/:id/participants/:userName` takes `reportingManager` (`users/…` or `null`); participants return `reportingManager` and `reportingManagerName`. New `GET /standups/:id/manager-candidates` (`people.manage`). `GET /requests` and `POST /requests/:id/{approve,decline}` admit a reporting manager under criterion 10 |
| MCP | None |
| Database | Migration 22, both dialects: `participants.reporting_manager` and `reporting_manager_name`, and an index on `reporting_manager` |
| Permissions | None new. Setting it needs `people.manage`; deciding comes from the relationship, alongside `schedules.manage` |
| Docs | `schedules.md` (who approves), `roles.md`, `web-app.md` (People table), `api.md` |
| Website | None |
| Google APIs and scopes | None |

How it works:

- The reporting manager is two columns on the `participants` row, so it is per
  standup by construction.
- Candidates are the distinct people in `standup_admins` on the tenant's
  active standups. The same query checks a pick, and checks a decider still
  manages somewhere (criterion 10).
- `setOverride` already loops over the standups that need approval and DMs
  their managers. It also DMs the person's reporting manager on each of those
  standups, skipping anyone already told.
- `decide` adds one check after the manager check: not a working request, the
  actor is the person's reporting manager on one of the person's `approval`
  standups, and the actor manages an active standup.
- `GET /requests` adds the actor's reports from criterion 10 to the people it
  lists, then keeps only their day-off requests.
- Removing someone leaves the column in place but inactive rows grant nothing;
  adding them back by hand clears it (criterion 6). A roster sync that brings
  someone back keeps it.

## Open questions

None.
