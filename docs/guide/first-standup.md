# 3. Guided setup and first test

Step 3 of the [setup path](./getting-started). Finish the guided setup, then run
a standup where only you can see it, before anyone else is prompted.

## Finish the guided setup

Open `https://HOST/app` and sign in with the operator token. A fresh install
opens the guided setup at `/app/setup`. Progress is saved as you go, and you
can come back to it any time.

| Step | What it checks |
| --- | --- |
| Create a Google Cloud project | The project number has the right format |
| Service account | The key mints a token and lists the spaces the app is in |
| Configure the Chat app | A signed event from Google Chat arrived |
| Sign-in for your team *(optional)* | Google or SAML sign-in; see [step 6](./enterprise-sso). Skip it for now if you like: the operator token keeps working |
| Create your first standup | Template, space, people, schedule |

Steps 1 to 3 are described in [step 2](./google-chat-setup). The rest of this
page covers the last one. **Before you reach it, make the private test space
below**, so it's there to pick.

## Make a private test space

1. In Google Chat, create a new space, e.g. *AsyncUp test*, with only yourself
   in it.
2. Add the app: open the space, **+ Add people & apps**, pick **AsyncUp**.

Nobody else sees a thing until you create a standup in a real team space.

## Create a test standup

In the guided setup (or later from **Standups → New standup**):

1. Pick a template. **Daily standup** is the usual one.
2. **Name**: something like *Test standup*. Names are unique across the
   workspace, archived standups included; the form warns before you press
   Create if the name is taken.
3. **Post in space**: your test space.
4. **Who is on it**: *People I pick from the space*. You are the only member,
   so you're ticked.
5. **Schedule**: set **Deadline** later than the current time. Prompt and
   deadline are time pickers; the deadline is in the standup's timezone.
6. Press **Create and run it now**.

`run now` (also the **Run now** button on a standup's Overview, and the
`@AsyncUp run now` command) is refused once today's deadline has passed,
because the run would close as soon as it opened. Move the deadline and try
again. A scheduled run never opens after its deadline either.

## Walk through a run

You get a DM card from AsyncUp.

1. **Skip first, to see it work.** Press **Skip today**. A one-line dialog asks
   why. The reason appears as a reply in today's thread in the test space, and
   your card changes to *You skipped today* with **Undo skip**.
2. **Undo it.** Press **Undo skip** (or DM the bot `unskip`). The thread reply
   disappears and the card offers **Fill standup** again.
3. **Answer.** Press **Fill standup**. Every question and the mood are
   required; answer the blockers question with "none" if you have none.
   Submit, and your answers post as a card under today's thread.
4. **Edit.** Your DM card now says *Submitted at …* with **Edit answers** until
   the deadline. Editing updates the posted card in place, marked *edited*.
5. **Try a blocker** (optional). Answer the blockers question with anything
   other than "none". The bot DMs you a blocker card with **Tag people**, so
   you can pull in whoever can help.
6. **Wait for the deadline.** The wrap-up posts in the thread: how many
   answered, and who didn't.

The web app's standup **Overview** shows the same run live: who submitted, who
is still expected, and who is away and why.

## Clean up

When you're done, remove the test standup:

1. Open it, **Settings → Danger zone → Archive standup**, type `ARCHIVE`.
2. Then **Delete standup**, and type the standup's name. This removes every
   run, answer, blocker and poll for good, and frees the name. Only workspace
   admins (and the operator token) can delete, and only an archived standup.

Messages already posted in Chat stay; delete the test space itself if you like.

## Next

[Step 4: roll out to your team](./distribution), then create the real standup
in your team's space, either here or with `@AsyncUp setup <name>` in Chat.
