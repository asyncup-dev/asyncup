# Getting started

AsyncUp asks every participant four questions in a DM each workday:

1. What did you do yesterday?
2. What will you do today?
3. Any blockers?
4. How is your mood today? (😄 🙂 😐 😕 😫)

Answers post as one card per person under a per-date thread in your team
space. At the deadline, AsyncUp posts a wrap-up with the submission count and
the names of mandatory participants who didn't fill it in.

## Prerequisites

- A Google Workspace domain where you can configure a Chat app
  (one-time, ~15 minutes — see [Google Chat setup](./google-chat-setup))
- Somewhere to run one small container with an HTTPS URL
  (see [Deployment](./deployment))

## Quickstart

```bash
git clone https://github.com/asyncup-dev/asyncup
cd asyncup
cp .env.example .env   # set GOOGLE_CHAT_AUDIENCE + service account key
docker compose up -d
```

Point your Chat app's HTTP endpoint at `https://<your-host>/chat/events`,
then in the space where reports should go:

```
@AsyncUp setup Engineering
@AsyncUp add @Alice @Bob @Carol
@AsyncUp optional @Carol
@AsyncUp time 09:30
@AsyncUp deadline 11:30
@AsyncUp timezone Asia/Kolkata
@AsyncUp status
```

That's it — prompts go out on the next configured workday.

## Try it without Google

The `fake` adapter logs all messages to the console instead of calling
Google Chat:

```bash
npm install
ADAPTER=fake npm run dev
curl -s -X POST localhost:8080/chat/events \
  -H 'Content-Type: application/json' \
  -d '{"type":"MESSAGE","space":{"name":"spaces/demo","type":"ROOM"},"message":{"argumentText":" setup Demo"}}'
```
