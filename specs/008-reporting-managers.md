# 008: Reporting managers can approve their reports' time off

| | |
| --- | --- |
| Status | Approved for local build (maintainer approval still required to upstream) |
| Size | Cross-cutting (migration, API, web app, permissions) |
| Figma | None — no access. UI validated by local deploy. Blocks an upstream PR until frames exist |
| PR | — |

## Problem

Time off under the `approval` policy can only be decided by workspace
admins and the standup's managers (`schedules.manage`). The person who
should sign off a day away is often a line manager who isn't a manager of
that team — so to let them approve, you have to make them a full manager of
the standup, handing them its whole configuration. There is also no record
of who a person reports to on a given team. We want a per-team reporting
manager, chosen from people who already manage somewhere, who can approve
their reports' days off without being made a manager of this standup.

## User stories

- As an admin or standup manager, I want to set who a person reports to on
  this team, so the right person signs off their days off.
- As a reporting manager, I want my reports' off-day requests to reach me
  and let me approve or decline them, in Chat or the web app, without being
  a manager of the standup.
- As someone on two teams, I want the right manager on each team to be able
  to approve my leave, since I answer to different people per team.

## Acceptance criteria

Assigning a reporting manager (per team)

1. Given someone with `people.manage` on a standup, when they set a
   participant's reporting manager on that standup's team view, then it is
   saved against that person on that standup and shown on the row.
2. The reporting manager can only be someone who is **assigned as a manager**
   on at least one standup. The picker offers only those people; choosing
   anyone else is refused: "A reporting manager must already be a manager on
   a standup."
3. A person cannot be their own reporting manager on a standup: the save is
   refused with "Someone can't report to themselves."
4. Clearing the field removes it; that person then has no reporting manager
   on that standup and the approver set reverts to the team's managers and
   admins.
5. The reporting manager is per standup: the same person on another standup
   can have a different reporting manager, set independently.

Approving as a reporting manager

6. Given a standup on the `approval` policy, when a person requests a day
   **off**, then the pending-request card is DMed to that standup's managers
   and admins **and** to that person's reporting manager on that standup, if
   set and not already among them.
7. A **working** request (back-to-work on an off day) is not sent to the
   reporting manager; it goes to the standup's managers and admins only, as
   today.
8. When any eligible approver — a manager/admin of an affected standup **or**
   that person's reporting manager on an affected standup — approves or
   declines an off-day request, the decision applies exactly as a manager's
   does today across all the person's standups: the run is updated, the
   person is told, and the webhook fires. **The first decision wins** (others
   see "already decided").
9. A reporting manager sees their reports' pending off-day requests on Team ›
   Requests for the standups they are the reporting manager on, even if they
   do not manage those standups.
10. A reporting manager who is also the requester cannot decide their own
    request: "Your own requests go to your managers." (Unchanged behaviour.)
11. The reporting manager relationship only grants approval under the
    `approval` policy. It creates no new approval path on `self` or
    `managers` standups.

No regression to the downstream flow

12. An approval made by a reporting manager marks the person away for that
    run, and their Google Calendar out-of-office, Workspace status and the
    "off" chart update exactly as an admin's approval does today — the same
    `applyToRuns` → `LeavePresence` path, no new sync code.

## Non-goals

- **Half-day or partial-day leave.** Dropped; leave stays whole-day.
- A reporting manager **setting or changing** a report's schedule directly.
  They approve requests; marking someone away stays with managers/admins.
- A reporting manager deciding **working** requests (criterion 7).
- **Each-team-must-approve.** One approval settles the request for all of a
  person's teams, as today. No partial-approval state.
- Letting anyone who is not already a manager be a reporting manager.
- Deriving the reporting manager from the Google Directory org chart or SCIM.
- A workspace-wide "one boss" per person, approval chains, or delegates.
- MCP changes.

## Design impact

| Area | Change |
| --- | --- |
| Web app | On each standup's team view, a **Reporting manager** control on every participant row — a picker listing the workspace's managers, with a clear option, behind `people.manage`. Team › Requests also lists off-day requests where the caller is the reporting manager |
| Chat cards and dialogs | None new. The existing time-off request card (`sendTimeOffRequest`) is additionally DMed to the reporting manager, for off-day requests only |
| API and OpenAPI | `PATCH /standups/:id/participants/:userName` gains a `reportingManager` field (`users/…` or `null`); the participant payload returns it. `GET /requests` widens its result to include off-day requests where the caller is a reporting manager; `POST /requests/:id/{approve,decline}` accepts a reporting manager as decider |
| MCP | None |
| Database | New migration, both dialects: two columns on `participants` — `reporting_manager` (the manager's `users/…`, nullable) and `reporting_manager_name` (their display name) |
| Permissions | None new. Assigning uses existing `people.manage` on the standup; deciding as a reporting manager is granted by the relationship, alongside `schedules.manage` |
| Docs | `roles.md` and/or `schedules.md` (who can approve), `web-app.md` (team row), `api.md` (participant field + widened requests) |
| Website | None |
| Google APIs and scopes | None |

How it works:

- The reporting manager is a per-participant attribute, so it lives as two
  columns on `participants` — the table already keyed by `(standup_id,
  user_name)`. Same person on two standups → two independent values. This
  mirrors how `standup_admins` and the `mandatory` flag already work.
- Candidates are people assigned as a manager on at least one standup
  (`standup_admins`), gathered across the tenant. The web picker shows that
  set; the API validates the chosen `reportingManager` is in it.
- Assignment reuses the existing participant route
  (`PATCH /standups/:id/participants/:userName`), which already needs
  `people.manage` — no new route, no new permission.
- `ScheduleService.setOverride`, when an **off** request goes `pending`,
  already DMs each governed standup's admins; it additionally reads that
  person's `reporting_manager` on each such standup and DMs them the same
  card, de-duplicated against admins already told. A `working` pending
  request skips the reporting manager.
- `ScheduleService.decide` gains one authority branch: alongside
  `actor.admin` and `schedules.manage`, the actor may decide an off-day
  request if they are the requester's reporting manager on any of the
  requester's standups. The self-request guard (criterion 10) is already
  there and still applies, and "first decision wins" is the existing
  behaviour — one approval clears the person's leave across every team.
- `GET /requests` builds its `names` list from the standups the caller
  manages; it now also adds the people who report to the caller on any
  standup, so a reporting manager who manages no standup still sees their
  reports' off-day requests.
- Approval runs the existing path unchanged: `decide` → `applyToRuns` →
  the next `LeavePresence.sweep` writes the calendar and status, and the run
  shows the person off. Criterion 12 is a no-new-code assertion, covered by
  a test that a reporting-manager approval leaves the same run/leave state
  as an admin approval.
- Failure cases: a reporting manager who stops being a manager everywhere
  keeps their existing assignments working (they are still a valid decider
  for those), but can no longer be picked afresh. One removed from the
  workspace leaves a dangling `reporting_manager`; `decide` finds no match
  and the normal approvers still apply.

## Open questions

None. Decided for the local build on 25 Oct 2026:

- The reporting manager is **per team** (per standup), stored on the
  participant row.
- Candidates are **existing roster members already assigned as managers**.
- The reporting manager approves **off-day requests only**, not working
  requests.
- **One approval** settles an off-day request across all of a person's
  teams (first decision wins), as today.
- No Figma access: the UI is **validated by local deploy**. This is a
  deliberate deviation from the Definition of Done and must be resolved with
  frames before any upstream PR.
