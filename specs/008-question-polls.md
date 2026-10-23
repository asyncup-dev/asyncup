# 008: Polls with questions and a deadline

| | |
| --- | --- |
| Status | Done |
| Size | Cross-cutting (migration, Chat cards and dialogs, web app, API, MCP, webhook) |
| Figma | [Specs › 008 Polls with questions](https://www.figma.com/design/OQfcL61rbaGakS2FjBKasI?node-id=186-82) |
| PR | Link once opened |

## Problem

A manager who wants a quick read from the team, such as a release retro, a
lunch order or an on-call preference, has two poor options today. The
`poll` command asks one question with up to six buttons, in the space, with
no deadline. A Google Form or a separate poll tool loses the roster: nobody
knows who hasn't answered, and nobody reminds them. AsyncUp already knows
each standup's people, their timezones and who is away, so it can ask a
few questions of exactly those people and close on time.

## User stories

- As a standup manager, I want to send my team a one-off poll with several
  questions of different kinds, so I get the answers I need in one go.
- As a standup manager, I want the poll to close at a set time, with a
  reminder to anyone who hasn't answered, so I get answers in time.
- As someone on the standup, I want to answer in Chat and change my answer
  until it closes.
- As a standup manager, I want the results in one place, named or
  anonymous as I chose, and exportable.

## Acceptance criteria

Creating a poll (web app)

1. Anyone with `standups.configure` on a standup can create a poll from
   its **Polls** tab: a title (up to 100 characters), an optional intro
   (up to 500), and 1 to 10 questions.
2. Each question has text (up to 200 characters), a type and whether it
   is required. The types are:
   - **Short text**: one line, up to 200 characters.
   - **Long text**: several lines, up to 1,000 characters.
   - **Dropdown**: one choice from a menu.
   - **Single choice**: one choice, shown as radio buttons.
   - **Multiple choice**: any number of choices, shown as checkboxes.

   Choice questions have 2 to 20 options of up to 80 characters each.
3. The poll has a close time, from 15 minutes to 14 days ahead, entered
   in the standup's timezone. It has an optional reminder, sent 15
   minutes, 1 hour (the default) or 1 day before the close time, as long
   as that is still ahead when the poll is sent.
4. The creator chooses **Named** or **Anonymous**, and who sees results:
   **Everyone, after it closes** (the default) or **Managers only**.
   Neither can be changed once the poll is sent.
5. A preview shows the Chat form as people will see it. **Send** sends the
   poll; until then nothing is stored.

Sending and answering (Chat)

6. On sending, everyone active on the standup's roster gets a DM card
   with the title, the intro, the close time and **Respond**. People on
   vacation are skipped. Only the people asked can answer.
7. The standup's space gets a summary card: the title, who sent it, the
   close time, and "3 of 8 answered". The count is redrawn at most once a
   minute.
8. **Respond** opens a Chat form with every question in order. Required
   questions say so. Submitting with a required question unanswered shows
   "Answer “Which day suits you?”" in the form and keeps what was entered.
9. After submitting, the DM card shows "Answered at 14:02. You can change
   your answers until 17:00 Asia/Kolkata." with **Change answers**, which
   reopens the form with the previous answers filled in.
10. The poll's close time is shown in the standup's timezone everywhere,
    such as "Fri 24 Oct, 17:00 Asia/Kolkata".

Timer

11. At the reminder time, everyone asked who hasn't answered gets one DM:
    "⏰ Release retro closes at 17:00 Asia/Kolkata." with **Respond**.
    Nobody gets more than one reminder.
12. At the close time the poll closes. A form opened before the close and
    submitted after it is refused: "This poll closed at 17:00." Every DM
    card and the space card redraw to "Closed".
13. A manager can close a poll early from the web app, with the same
    effect.
14. Closing is idempotent and runs from the database, so a restart never
    closes twice or skips a close.

Results

15. When a poll closes, the space gets a results post:
    - **Everyone, after it closes**: for each choice question, a count per
      option. For a named poll, the names follow each option. For each
      text question, the number of answers. The post links to the web app
      for the text answers.
    - **Managers only**: "Release retro closed: 7 of 8 answered. Results
      are with the standup's managers."
16. The web app shows results to anyone with `standups.configure` on the
    standup: answered and not answered, a bar per option, and every text
    answer. For an everyone-sees poll, people asked can also see results
    after it closes. (Members hold `answers.view`, so that permission would
    show results early and break **Managers only**.)
17. An anonymous poll never shows who answered what, to anyone, anywhere:
    the web app, the space post, CSV, the API, MCP and webhooks. The web
    app still shows how many have answered.
18. Managers can download results as CSV: one row per answer for a named
    poll, and one row per answer without the person for an anonymous one.

Integrations

19. The API lists, creates, reads and closes polls, and exports CSV, with
    the same permissions. MCP gets read-only tools to list polls and read
    results.
20. A `poll_closed` webhook fires on close with the counts. It includes
    names only for a named poll.

## Non-goals

- Creating these polls from Chat. The `poll` command stays as the quick
  one-question poll.
- Answering through the API or MCP.
- Recurring or scheduled polls, and editing a poll after it is sent.
- Asking people outside the standup's roster, or people who join it after
  the poll is sent.
- Live results while the poll is open.
- More than one reminder, and reminders in the space.
- Other question types: dates, ratings, file uploads.

## Design impact

| Area | Change |
| --- | --- |
| Web app | Standup **Polls** tab: open and closed polls, **New poll** builder with a preview, a results page with CSV download, and **Close now** |
| Chat cards and dialogs | DM poll card (open, answered, closed). Space summary card (open, closed). Response form with validation errors. Reminder DM. Results post. "Poll closed" error |
| API and OpenAPI | `GET/POST /standups/:id/question-polls`, `GET /question-polls/:id` (results by permission), `POST /question-polls/:id/close`, `GET /question-polls/:id/export.csv`. New schemas for polls, questions and results |
| MCP | `list_question_polls`, `get_question_poll_results` (read scope) |
| Database | Migration 21, both dialects: `question_polls` (standup, title, intro, questions as JSON, named or anonymous, results visibility, close time, reminder, creator, sent and closed times, space card name) and `question_poll_people` (poll, person, DM card name, reminded at, answers as JSON, answered and updated times) |
| Permissions | None new. Create, close, results and CSV: `standups.configure`. People asked see results after an everyone-sees poll closes |
| Webhooks | New `poll_closed` event |
| Docs | `user-guide.md` (answering a poll), `web-app.md` (Polls tab), `commands.md` (`polls` lists these too), `api.md`, `mcp.md`, `configuration.md` (webhook), `roles.md` |
| Website | `site/index.html`: a few words in the features list |
| Google APIs and scopes | None |

How it works:

- A new `QuestionPollService` in `src/core` creates, sends, records
  answers, reminds and closes. The scheduler tick reminds and closes due
  polls from the database, so ticks stay idempotent.
- Cards and the form go through `ChatAdapter`. The form is a Chat dialog,
  which only the person who opened it can see.
- Checked against Google's Chat docs on 23 Oct 2026 (cards reference,
  updated 18 Sep 2026; dialogs and form data, updated 9 Oct 2026):
  - Text inputs, dropdowns, radio buttons and checkboxes all work in
    dialogs. Each allows up to 100 options, and a card allows up to 100
    widgets and 32 KB, so 10 questions of 20 options fit in one form.
  - Chat can only enforce required answers for text and dropdowns, not
    radio buttons or checkboxes. AsyncUp validates every question itself,
    and returns the error to the form with `INVALID_ARGUMENT`.
  - A space accepts one message write a second, shared by every app in it,
    which is why the space card is redrawn at most once a minute.
  - Answers arrive as strings keyed by widget name, so each widget is
    named after its question's position.
- Anonymous answers are stored with the person, as anonymous moods are, so
  they can change their answers and reminders skip them. No view, export,
  API, MCP tool or webhook returns the person for an anonymous poll.
  Whoever runs the database can still link them, and the docs say so.

## Open questions

None. Decided with the maintainer on 23 Oct 2026:

- A poll goes to a standup's roster by DM, with a summary card in its
  space.
- Question types: short and long text, dropdown, single choice (radio)
  and multiple choice (checkboxes), with a close time.
- Up to 10 questions per poll and 20 options per choice question.
- Results go to everyone after the poll closes, or to managers only. No
  live results.
- Everyone active on the roster is asked, including people away that day.
  Only people on vacation are skipped.
