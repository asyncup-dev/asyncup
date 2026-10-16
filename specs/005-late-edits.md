# 005: Editing answers after the deadline, with approval

| | |
| --- | --- |
| Status | Done |
| Size | Cross-cutting (migration, API, Chat cards, web app) |
| Figma | [Specs › 005 Late edits](https://www.figma.com/design/OQfcL61rbaGakS2FjBKasI?node-id=162-56) |
| PR | Link once opened |

## Problem

Once a standup's deadline passes, an answer can't be changed. Someone
who spots a mistake, or whose plan changed, has to post a correction
by hand, and the wrong answer stays in History, exports and webhooks.
Opening edits to everyone would let answers change after the wrap-up
has been read, so a manager should agree first. Separately, a missed
standup can be answered late at any time today, even days later,
which makes old runs change long after anyone looks at them.

## User stories

- As someone who answered, I want to ask to change my answers after
  the deadline, so the record is right.
- As a standup manager, I want to approve or decline those requests in
  Chat or the web app, so answers only change when I agree.
- As someone who missed the standup, I can still answer late that day,
  without asking anyone, as today.

## Acceptance criteria

Late first answers

1. Given someone has not answered, when they submit after the deadline
   but on the run's day (standup timezone), then the answer posts,
   marked late, with no approval, as today.
2. Given the run's day has ended, when they open or submit the form,
   then it is refused: "This standup has closed. Answers for Thu
   15 Oct can no longer be added." MCP `submit_answers` refuses the
   same way.

Asking to edit

3. When a run closes, the prompt card of everyone who answered is
   redrawn: "Submitted at 09:12. The deadline has passed. Need to
   change something? Ask a manager." with an **Ask to edit** button.
4. **Ask to edit**, or **Edit answers** on a card drawn before the
   deadline, opens a dialog with an optional reason (up to 200
   characters) and **Send request**.
5. On sending, every manager of the standup gets a DM card: who, which
   standup and day, the reason, **Approve** and **Decline…**. The
   person is told "Sent to your managers. You'll hear back here."
6. Given a pending request, a second ask says "Your request is waiting
   for a manager." One request per person per run: once declined, they
   can't ask again that day.
7. Given the run's day has ended, **Ask to edit** says the day has
   closed and sends nothing.

Deciding

8. Anyone holding `standups.configure` on the standup can decide, in
   Chat or on the web app's Team › Requests. Nobody decides their own
   request: "Your own requests go to your managers."
9. The first decision wins. Every manager's card is redrawn to
   "Approved by Asha" or "Declined by Asha", and a later click says it
   was already decided.
10. **Decline…** asks for an optional note, sent to the person.
11. Given no decision by the end of the run's day, the request lapses:
    the person is told, and the managers' cards say "Lapsed".

Editing after approval

12. On approval, the person gets a DM: "Asha approved your request.
    Edit your answers before 23:59 Europe/London." with **Edit
    answers**, and their prompt card shows the same button.
13. Until the end of the run's day they can edit as often as they like,
    from Chat or MCP. After that, edits are refused as in criterion 2.
14. The posted answer is updated in place, and its card reads "Edited
    after the deadline · approved by Asha".
15. The `submission` webhook fires with `edited: true` and a new field
    `editApprovedBy` (the approver's name, otherwise `null`).
16. The wrap-up already posted is not changed.

## Non-goals

- Approval for a first late answer.
- Asking to edit from the web app or MCP. Asking happens in Chat.
- Deciding from MCP.
- Reposting or editing the wrap-up after an approved edit.
- Editing runs from earlier days.

## Design impact

| Area | Change |
| --- | --- |
| Web app | Team › Requests: an **Edit requests** list beside time-off requests, with Approve and Decline…. The tab shows to anyone who can decide either kind |
| Chat cards and dialogs | Prompt card after the deadline (**Ask to edit**). Ask dialog. Manager's request card, pending and decided. DMs for approved, declined and lapsed. "Day closed" dialog error. Posted answer's "Edited after the deadline · approved by" line |
| API and OpenAPI | `GET /edit-requests` (pending requests the caller can decide), `POST /edit-requests/:id/approve` and `/decline` taking `DecisionBody`. Permission `standups.configure` on the request's standup. The `submission` webhook gains `editApprovedBy` |
| MCP | `submit_answers` refuses after the run's day ends, and refuses an edit after the deadline without approval: "Ask a manager to let you edit, from your prompt card in Chat." |
| Database | Migration 20, both dialects: `edit_requests` (run, person, reason, status `pending`, `approved`, `declined` or `lapsed`, asked at, decided at, decided by, note, and the managers' DM message names, one per person and run), and `submissions.edit_approved_by` for the posted card and the webhook |
| Permissions | None new. Deciding needs `standups.configure` |
| Docs | `user-guide.md` (late answers and asking to edit), `web-app.md` (Team › Requests), `api.md` (routes), `configuration.md` (webhook field) |
| Website | `site/index.html`: one line under answering in Chat |
| Google APIs and scopes | None |

How it works:

- "The run's day" ends at midnight in the standup's timezone.
  `StandupService.submit` refuses after that, so Chat and MCP agree.
- `submit` lets an existing answer change after the deadline only with
  an approved request for that run and person, before midnight.
- A new `EditRequests` service in `src/core` asks, decides and lapses.
  The scheduler tick lapses pending requests whose day has ended. It
  runs from the database, so a restart doesn't send anything twice.
- Manager cards are sent through `ChatAdapter`, and their message names
  are stored so a decision can redraw all of them.
- When a run closes, the prompt cards of people who answered are
  redrawn with the existing `refreshCards`.
- The prompt card then follows the request: waiting, approved (with
  **Edit answers**), declined or lapsed.
- Request rows on Team › Requests wrap their buttons under the text on a
  phone; time-off rows had squeezed their text there too.

## Open questions

None. Decided with the maintainer on 16 Oct 2026:

- Approval is needed only to edit an answer after the deadline.
- A first late answer posts without approval, until the end of that day.
- Approvers are the standup's managers, and anyone with
  `standups.configure` on it, in the web app.
- The window ends at midnight in the standup's timezone.
- The wrap-up is not reposted after an approved edit.
- One request per person per run.
