# 006: Text formatting in answers

| | |
| --- | --- |
| Status | In progress |
| Size | Feature (cards, web app, no schema change) |
| Figma | [Specs › 006 Text formatting](https://www.figma.com/design/OQfcL61rbaGakS2FjBKasI?node-id=166-79) |
| PR | Link once opened |

## Problem

People already type Chat's shorthand in their answers, such as `*done*`
or a few `- ` lines, out of habit. AsyncUp posts it as literal
asterisks and dashes, so answers are harder to scan than the same
message sent in Chat. Separately, answer and blocker cards pass typed
text straight into card HTML today, so an answer containing `<b>` or a
link tag is rendered as markup instead of shown as typed.

## User stories

- As someone answering, I want the shorthand I use in Chat to work in
  my answers, so a list of tickets reads as a list.
- As someone reading the thread or the web app, I want emphasis and code
  to show as formatting, not as stray symbols.
- As anyone integrating with AsyncUp, I want the text exactly as typed
  in the API, exports and webhooks.

## Acceptance criteria

The shorthand

1. `*bold*`, `_italic_`, `~strike~`, `__underline__` and `` `code` ``
   are formatted. A line starting with `- ` is a list item; consecutive
   items form one list.
2. A marker only counts when it sits right against the text, at a word
   edge, on one line: `snake_case`, `2*3*4`, `file_name.ts`, `* not
   bold *` and an unmatched `*` stay as typed.
3. Nothing inside backticks is formatted.
4. Any other HTML in an answer is shown as typed, never rendered.

Where it shows

5. The posted answer card renders the shorthand as card formatting.
6. Blocker cards (the owner's card and the tagged person's card) render
   it in the blocker text.
7. Plain-text Chat messages that quote answers or blockers (nudges,
   escalations, blocker updates, the weekly digest) keep Chat's own
   syntax, which Chat renders itself. `__underline__` loses its markers
   there, because Chat text messages can't underline.
8. The web app renders it in History, My standups, Blockers, Reports
   and the standup overview, without inserting raw HTML.
9. The API, MCP, CSV export and webhooks return the text exactly as
   typed.

Writing it

10. Each answer field in the Chat form shows the hint "Formatting:
    \*bold\* \_italic\_ \~strike\~ \_\_underline\_\_ \`code\`, and - for a
    list." The blockers field keeps "Write "none" if you have no
    blockers" before it.
11. Spelling suggestions ignore the markers, so `__teh__` is still
    checked and `*` is never flagged.

## Non-goals

- Numbered lists, nested lists, headings, links and block quotes.
- Code blocks across several lines.
- A formatting toolbar or preview.
- Formatting in mood comments, skip reasons or blocker updates.
- Changing stored answers.

## Design impact

| Area | Change |
| --- | --- |
| Web app | Answers and blocker text render formatting in History, My standups, Blockers, Reports and the standup overview |
| Chat cards and dialogs | Posted answer and blocker cards render formatting; the answer form's hints list the shorthand |
| API and OpenAPI | None. Text stays as typed |
| MCP | None |
| Database | None |
| Permissions | None |
| Docs | `user-guide.md` (formatting answers), `commands.md` (behaviour notes) |
| Website | `site/index.html`: a few words in "Everyone gets a card" |
| Google APIs and scopes | None |

How it works:

- One parser in `src/core/format.ts` turns text into a small tree:
  text, bold, italic, strike, underline, code and list items. Two
  renderers use it: card HTML (escaping everything first) and Chat
  text (dropping `__` markers). The web app imports the same parser and
  builds React elements from its tree (`web/src/lib/formatted.tsx`).
- Card HTML uses the tags Google documents for cards: `<b>`, `<i>`,
  `<s>`, `<u>`, `<code>`, `<ul><li>` and `<br>` (checked 16 Oct 2026,
  developers.google.com/workspace/chat/format-messages, last updated
  9 Oct 2026).
- Spelling passes text with markers blanked out to Harper, so positions
  still line up.

## Open questions

None. Decided with the maintainer on 16 Oct 2026:

- The shorthand is Chat's own, plus `__underline__`.
- Blocker text gets the same formatting as answers.
- Stored text, the API and integrations keep the text as typed.
