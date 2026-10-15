# 004: Spelling suggestions

| | |
| --- | --- |
| Status | Done |
| Size | Feature (new dependency, settings) |
| Figma | [Specs › 004 Spelling suggestions](https://www.figma.com/design/OQfcL61rbaGakS2FjBKasI?node-id=159-26) |
| PR | [#104](https://github.com/asyncup-dev/asyncup/pull/104) |

## Problem

Standup answers are typed fast, in a small Chat form, and posted
straight into the team's space. Typos go out with them, and nobody can
fix them without editing. Chat's form has no spell check of its own.

## User stories

- As someone answering, I want likely typos pointed out before my
  answer is posted, so I can fix them, without being blocked or having
  my words changed for me.
- As a team with its own jargon, I don't want "k8s", ticket IDs or our
  tool names flagged.
- As a Workspace admin, I want this off until I choose it, and to pick
  British or American spelling.

## Acceptance criteria

The setting

1. Settings › General has **Spelling suggestions**, off by default,
   with **Spelling**: *British English* or *American English*.
2. **Words to accept** is a list admins keep, one word or phrase per
   line. Those words are never flagged. Names on any roster are
   accepted too.

On submit

3. Given spelling suggestions are on, when someone submits the Chat form
   with likely typos in an answer or their mood comment, then the form
   comes back with every answer kept and a notice: "Possible typos. Fix
   them, or submit again to send as is: Reveiwed → Reviewed · teh →
   the".
4. When they submit again, the answers are saved as typed, typos or
   not. AsyncUp never changes their words.
5. Given no likely typos, or the setting is off, the form submits as
   today.
6. Editing an answer works the same way.

What is checked

7. Only spelling and typos, never grammar or style.
8. Skipped: text in backticks, URLs, @mentions, words with digits,
   ALL-CAPS words, words with an inner capital (camelCase), words
   joined by `/`, `_`, `.` or `-`, and capitalised words mid-sentence
   (names and products).
9. With British spelling, American spellings are suggested in their
   British form ("color → colour"), and the reverse with American.

Cost and failure

10. The checker runs in its own process, started at the first answer
    and stopped after 30 minutes without one, so its memory (about
    350 MB) is only held while people are answering.
11. If the checker can't start within ten seconds, or doesn't answer
    within two, the answer is saved unchecked and the failure is logged.
    Spelling never blocks an answer.

Web app

12. The web app's page language follows the setting (`en-GB` or
    `en-US`), so the browser's own spell check uses it in free-text
    boxes, such as blocker updates and time-off reasons.

## Non-goals

- Grammar, style or tone suggestions.
- Correcting text automatically.
- Checking answers sent through the API or MCP.
- Personal word lists, or dialects other than British and American.
- Checking answers already posted.

## Design impact

| Area | Change |
| --- | --- |
| Web app | Settings › General: a **Spelling suggestions** card with the switch, the dialect and **Words to accept**. The page's `lang` follows the dialect |
| Chat cards and dialogs | The answer form gains a "Possible typos" notice, shown once per submit; the second submit carries a flag so it goes through |
| API and OpenAPI | `WorkspaceSettings` gains `spelling: { enabled, dialect: 'en-GB' \| 'en-US', words: string[] }`; `PATCH /settings` takes `spellingEnabled`, `spellingDialect`, `spellingWords` |
| MCP | None |
| Database | None. The settings are stored like the others |
| Permissions | None. The card needs `settings.manage` |
| Docs | `user-guide.md` (the form), `web-app.md` (Settings › General), `configuration.md` (memory and the dependency), `api.md` (settings fields) |
| Website | `site/index.html`: a short mention under answering in Chat |
| Google APIs and scopes | None. Everything runs in-process, nothing leaves the server |

How it works:

- Dependency: `harper.js` 2.10.0 (Apache-2.0), the slim binary. It adds
  about 72 MB to the installed packages.
- `HarperEngine` (`src/integrations/harper.ts`) starts
  `bun src/spell/worker.ts` on first use and talks to it a JSON line at a
  time. It stops the child after 30 idle minutes, counted from the last
  answer, and replaces a child that stops answering. Starting has its own
  ten-second allowance: a cold start took 1.3 s end to end locally. Measured on 15 Oct 2026: about 0.38 s to start,
  about 0.5 ms per answer, and about 350 MB in the child. The server
  itself stays near 27 MB. Freeing the linter inside the server, or in
  a worker thread, did not give the memory back; ending the process did.
- The child returns Harper's Spelling and Typo lints. The server drops
  the skipped ones (criterion 8), the accepted words and roster names,
  and keeps the first suggestion for each.
- The Chat dialog's submit action carries `spellingShown=1` once the
  notice has been shown, so the next submit skips the check.

Trial on 15 Oct 2026, 16 realistic answers, British English:

- Correct British spelling was never flagged.
- Every real typo was caught with the right first suggestion.
- Before the skip rules: 22 flags, nearly all jargon. After the skip
  rules and roster names, three false alarms were left ("Terragrunt",
  "wfh", "cron"). The capitalised-word rule removes "Terragrunt", and
  the word list handles the rest.

## Open questions

None. Decided with the maintainer on 15 Oct 2026:

- Show typos once, then accept the second submit.
- Load on use, unload after 30 idle minutes.
- Skip capitalised words mid-sentence.
- A workspace word list, plus roster names.
