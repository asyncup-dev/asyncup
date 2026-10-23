# User guide

For everyone on a standup roster. Total daily effort: about a minute. Share
this page with your team.

## Your daily flow

At the standup's prompt time, in **your** timezone, AsyncUp sends you a card
in a Google Chat DM.

1. Press **Fill standup**. One form, all the questions, one submit. Every
   question and the mood are required: if one is empty, the form comes back
   with a red line naming it and your answers kept. Answer the blockers
   question with "none" when there are none.
   After the mood there's an optional **Want to say why?** box, up to 200
   characters. Only people allowed to read mood comments see it, and it is
   never posted in the space.
   With **spelling suggestions** on, likely typos come back once, with your
   answers kept: *Possible typos. Fix them, or submit again to send as is:
   Reveiwed → Reviewed*. Submit again and your answers post exactly as typed.
   Code in backticks, links, @mentions, IDs like `PROJ-1423`, words with
   digits or capitals, and names are left alone.
   Answers take Chat's shorthand: `*bold*`, `_italic_`, `~strike~`,
   `__underline__`, `` `code` ``, and `- ` at the start of a line for a
   list. Each field's hint lists them. Markers only count right against
   the text, so `snake_case` and `2*3*4` stay as typed.
2. Your answers post as your card under today's thread in the team space.
   Your mood never appears there: it's seen in the web app only.
   "Yesterday" comes pre-filled from your previous "today".
3. Plans changed? Your DM card now shows *Submitted at …* with **Edit
   answers** until the deadline. Editing updates the posted card in place,
   marked *edited*. After the deadline a first answer still posts, marked
   *late*, until midnight in the standup's timezone.
4. Need to change an answer after the deadline? Press **Ask to edit** on your
   card, and say why if you like. Your standup's managers get a card with
   **Approve** and **Decline**. If one of them approves, you can edit until
   midnight, and your posted card reads *Edited after the deadline · approved
   by …*. You can ask once a day, and a request nobody decides lapses at
   midnight. The wrap-up already posted stays as it was.
5. Not today? Press **🏖️ Skip today** and say why in one line. The reason goes
   in today's thread, and you're listed as away, never as missing. Changed your
   mind? **↩️ Undo skip** (or DM `unskip`) before the deadline removes that
   reply and brings the form back.

Reminders and nudges update the same way as the prompt card.

## Blockers

Any blockers answer other than "none" opens a blocker. The bot DMs you its
card: **👥 Tag people** pulls in anyone in your Workspace who can help, **📝 Add
update** keeps everyone involved posted, **✅ Resolve** closes it.

When someone tags you on a blocker you get the same card. **✋ Acknowledge**
tells the reporter you're on it and stops the daily nudges.

Untagged blockers resolve themselves the next time you answer "none". Once a
blocker is tagged or has updates, only an explicit resolve closes it.

## DM the bot

| Message | Effect |
| --- | --- |
| `vacation` (or `ooo`) | Pause prompts across all your standups |
| `back` | Resume prompts |
| `unskip` | Take back today's skip while the run is open |
| `timezone Asia/Kolkata` | Get prompts at the standup's time in *your* zone |
| `timezone` / `timezone reset` | Show / clear your personal timezone |
| `off tomorrow comp off` / `off 22 sep to 24 sep sick` / `working sat` | A day (or range) off, or an extra working day — see [Personal schedules](./schedules) |
| `off list` / `off cancel <date>` | What's coming up / withdraw an entry |
| `days mon-thu` / `days adhoc` / `days reset` | Your days on your standup, or back to its days. On several standups, the bot asks which, for example `days #12 mon-thu` |

## Your own page — `/app/me`

Sign in at `https://HOST/app` with **Continue with Google** or **Continue with
SSO**. You get:

- today's standups with an **Answer in Chat** link and **Skip today** (it asks
  for the one-line reason too);
- your recent answers;
- your timezone, vacation mode and **My schedule** (your days on each standup, and days off).

If your account isn't linked to Chat yet, it links the first time you use the
bot, or straight away when your admins have set up the
[Directory](./directory).

## Polls

Anyone can start one in a space: `@AsyncUp poll Ship Friday? | Yes | No`. Tap an
option to vote; tap another to change your vote.

### Polls with questions

A standup's managers can also send a poll with several questions from the
web app (the standup's **Polls** tab). Everyone on the standup, except people
on vacation, gets a DM card with **Respond**:

- The form asks each question in turn: short or long text, a dropdown, one
  choice (radio buttons) or several (checkboxes). Questions marked
  *required* must be answered to submit.
- After you answer, **Change answers** reopens the form with your answers
  filled in, until the poll closes.
- One reminder comes before the close if you haven't answered yet.
- The close time is shown in the standup's timezone. After it, nothing is
  accepted, and the cards say *Closed*.
- An anonymous poll never shows who answered what, to anyone. A named poll
  shows the managers who answered what.
- The space gets a card with how many have answered. When the poll closes,
  the results post in its thread, or, if the managers keep them, a line
  saying so. Text answers stay in the web app.
