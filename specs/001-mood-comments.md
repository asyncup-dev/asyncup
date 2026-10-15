# 001: Mood comments, and mood out of the Chat space

| | |
| --- | --- |
| Status | In progress |
| Size | Cross-cutting (new permission, migration, API change) |
| Figma | [Specs › 001 Mood comments](https://www.figma.com/design/OQfcL61rbaGakS2FjBKasI?node-id=132-55) |
| PR | — |

## Problem

A mood of "Struggling" says something is wrong but not what. Managers
can't help without asking, and people may not want to explain in front
of their team. Mood also shows in the Chat space today: an emoji on each
posted answer, a team average in the wrap-up, the weekly digest and
`trends`. Mood is personal, and it should stay out of a shared space.

## User stories

- As someone answering, I can say why I feel the way I do, knowing it
  is never posted where my team can read it.
- As an admin, I can read mood comments so I can follow up with people
  who are struggling.
- As an admin, I can let someone else, such as an HR partner, read mood
  comments without giving them the whole Admin role.
- As a team member, I don't see anyone's mood or comment in the space.

## Acceptance criteria

Answering

1. Given a standup with mood on, when someone opens the form, then an
   optional field "Want to say why?" appears after the mood, with the
   hint "Only people allowed to read mood comments see this. It is never
   posted in the space."
2. Given someone leaves the field empty, when they submit, then the
   answer is saved and no comment is stored.
3. Given a comment over 200 characters, when they submit, then the form
   comes back with "Keep it to 200 characters." and their answers kept.
4. Given someone edits their answers while the run is open, when the
   form opens, then their comment is filled in, and saving replaces it.
5. Given a standup with mood off, then the field is not shown and no
   comment can be stored.
6. Given MCP `submit_answers`, then it accepts an optional
   `moodComment` under the same rules.

Mood out of the space

7. When an answer is posted in the space, then its card shows no mood:
   the header uses 📝 for everyone, whatever they picked.
8. When the wrap-up is posted, then it has no team-mood line.
9. When the weekly digest is posted, then it has no mood line.
10. When someone runs `trends` in the space, then the reply has no mood.
11. When someone runs `status`, then the reply says only whether the mood
    question is on, never anyone's mood (as today; a test keeps it so).
12. The replies to `mood on` and `mood anon`, and the `help all` line,
    no longer promise that moods show on cards or that the wrap-up shows
    a team average. They say moods are seen in the web app only.

Reading comments

13. Given someone holding `moods.comments` on a standup, when they open
    a run in History, then each answer with a comment shows it beside
    the mood, with the person's name.
14. Given the standup keeps moods anonymous, then the same person sees
    the run's comments in a separate "Mood comments" list, each with
    its mood and without a name, sorted by mood then text, so that
    neither the order nor the layout identifies anyone.
15. Given someone without `moods.comments` on that standup, then the web
    app, the API and MCP never return any comment, and History looks as
    it does today.
16. Given someone opens My standups, then their own recent answers show
    their own comment, whatever the standup's settings.
17. CSV export and webhooks never include comments, for any role.

Permission

18. A new permission `moods.comments`, "Read mood comments", is in the
    catalogue. It can be granted across the workspace or on one standup.
19. Admin holds it. Manager, Viewer and Member don't.
20. Settings › Roles lists it, so a custom role can include it.

## Non-goals

- Changing who sees per-person moods in the web app. That stays as
  today: shown unless the standup keeps moods anonymous.
- Mood comments in Insights, Reports or exports.
- Notifying anyone when a comment is left.
- Comments without a mood, or on standups with mood off.

## Design impact

| Area | Change |
| --- | --- |
| Web app | History run detail: comment beside the mood, or the anonymous "Mood comments" list. My standups: own comment under own answers. Settings › Roles: the new permission in the checklist |
| Chat cards and dialogs | Answer form: optional "Want to say why?" field after the mood. Posted answer: 📝 header, no mood. Wrap-up: no team-mood line. Digest and `trends`: no mood |
| API and OpenAPI | `RunDetail` gains `moodComments`: a list of `{ person \| null, mood, comment }`, present only with `moods.comments`; `person` is null when moods are anonymous. `MySubmission` gains `moodComment` |
| MCP | `submit_answers` accepts `moodComment`. `get_run` returns `moodComments` under the same rule as the API |
| Database | Migration 17 adds `submissions.mood_comment TEXT NULL` in both dialects |
| Permissions | New `moods.comments`, not workspace-only, held by Admin |
| Docs | `user-guide.md` (the form), `commands.md` (`mood` and `trends` rows), `configuration.md` (the webhook payload unchanged, stated), `roles.md` (permission table), `web-app.md` (History) |
| Website | `site/index.html`: the "Everyone gets a card" and "Insights built in" copy, checked for mood claims |
| Google APIs and scopes | None |

How it works:

- The form field is a single-line `TextInput` named `moodComment`. The
  submit handler trims it, stores `null` when empty and refuses more
  than 200 characters.
- `StandupService.submit` takes `moodComment` alongside `mood`, and edits
  replace it.
- `views.ts` adds `moodComments` to the run view only when the caller
  holds `moods.comments` on the standup. For anonymous standups the list
  drops `person` and is sorted by mood score, then by comment text.
- Posted answers, the wrap-up, the digest and `trends` stop reading
  mood. The weekly digest and `trends` keep participation and blockers.

## Open questions

None. Decided with the maintainer on 15 Oct 2026:

- Mood never appears in the Chat space.
- Comments are read under a new permission held by Admin.
- Names follow the standup's anonymous-moods setting.
- The field is always shown and optional.
