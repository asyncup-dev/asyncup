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
2. Your answers post as your card under today's thread in the team space.
   "Yesterday" comes pre-filled from your previous "today".
3. Plans changed? Your DM card now shows *Submitted at …* with **Edit
   answers** until the deadline. Editing updates the posted card in place,
   marked *edited*. After the deadline a first submission still posts, marked
   *late*.
4. Not today? Press **🏖️ Skip today** and say why in one line. The reason goes
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
| `days mon-thu` / `days adhoc` / `days reset` | Your own week, or back to the standup's |

## Your own page — `/app/me`

Sign in at `https://HOST/app` with **Continue with Google** or **Continue with
SSO**. You get:

- today's standups with an **Answer in Chat** link and **Skip today** (it asks
  for the one-line reason too);
- your recent answers;
- your timezone, vacation mode and **My schedule** (your week and days off).

If your account isn't linked to Chat yet, it links the first time you use the
bot, or straight away when your admins have set up the
[Directory](./directory).

## Polls

Anyone can start one in a space: `@AsyncUp poll Ship Friday? | Yes | No`. Tap an
option to vote; tap another to change your vote.
