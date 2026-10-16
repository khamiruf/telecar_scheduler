# Telecar

A shared family car, organised through Telegram. One bot, one Mini App, one Cloudflare Worker.

- **Where's the car?** Send the bot a voice note ("parked at level 4B") or just type `4B`.
- **Who has it?** `/where` answers in the chat; every change is announced in the family group.
- **Booking it** happens in the Mini App — a one-screen schedule with tap-to-book hours.
  You can also text the bot: "book saturday 2pm to 6pm", or "cancel my booking"
  (no date → your soonest upcoming booking; "cancel wednesday" → that day, Singapore time).

Everything runs on a single Cloudflare Worker (free tier): Hono API, D1 database, Workers AI
Whisper for voice transcription, static assets for the React Mini App.

```
src/
├── worker/            Hono backend
│   ├── index.ts       routes: /api/*, /telegram/webhook, cron reminders
│   ├── core/          domain logic (bookings, car status, users/whitelist)
│   └── telegram/      webhook handler, voice transcription, initData auth, notifications
├── app/               React Mini App (Tailwind v4, Telegram theme variables)
└── shared/            types used by both
migrations/            D1 schema
```

## Security model

- The Mini App authenticates every API call with Telegram `initData`, verified server-side
  (HMAC with the bot token). No initData, no access.
- The whitelist lives in the `users` D1 table. `ADMIN_ID` is always allowed and can add
  others with `/add <id> <name>`.
- The webhook is protected by a secret token that Telegram echoes back on every delivery.

## Setup (one time, ~10 minutes)

### 1. Create the bot

Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **bot token**.

### 2. Create the database

```sh
npm install
npx wrangler login
npx wrangler d1 create telecar      # copy the database_id it prints
```

Paste the `database_id` into `wrangler.jsonc`, and set `ADMIN_ID` to your own Telegram id
(don't know it? finish setup and send the bot `/id`, or ask @userinfobot).

### 3. Set secrets

The **webhook secret is a password you invent** — it isn't issued by Telegram. You'll give
the same value to Cloudflare (step below) and to Telegram (step 5); the Worker rejects any
webhook call that doesn't carry it.

```sh
openssl rand -hex 32                              # invent the webhook secret
npx wrangler secret put TELEGRAM_BOT_TOKEN        # paste the BotFather token
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # paste the random string
```

### 4. Deploy

```sh
npm run db:migrate    # applies migrations/ to the remote D1
npm run deploy        # prints your worker URL, e.g. https://telecar.<you>.workers.dev
```

### 5. Point Telegram at it

```sh
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://telecar.<you>.workers.dev/telegram/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

### 6. Wire up the family group

1. Add the bot to your family group chat.
2. Type `/id` in the group — the bot replies with the chat id (negative number).
3. Put it in `wrangler.jsonc` as `GROUP_CHAT_ID` and run `npm run deploy` again.

### 7. Make the Mini App openable from the bot

In @BotFather: `/mybots` → your bot → **Bot Settings → Menu Button** → set the URL to your
worker URL. (The bot also offers an "Open schedule" button on `/start` and `/app`.)

### 8. Let people in

Each person messages the bot `/start`; it replies with their id. You add them:
`/add 123456789 Mum`. Done.

## Daily use

| Action | How |
|---|---|
| Update parking spot | Voice note or text to the bot: "parked at 4B", `B2`, "level five" |
| Check on the car | `/where` (works in the group too), or ask "where's the car?" |
| Is it free? | "is the car free tomorrow evening?" — replies with who has it, free gaps and Book buttons |
| Book / cancel | Mini App — tap a free hour, extend by tapping another, confirm |
| Book / cancel by text | "book tonight 7pm", "cancel my booking", "move friday to saturday" |
| See bookings | `/bookings`, or "find my upcoming bookings" / "who has the car this week" |
| Open the schedule | `/calendar` (or `/app`), or "show me the calendar" |
| Help | `/help`, "what can you do?" — private-chat text and voice notes accept all of the above, incl. Singlish/Malay |
| Reminders | The group gets a ping ~30 min before each booking starts |

## Development

```sh
cp .dev.vars.example .dev.vars   # set DEV_USER_ID + ADMIN_ID to the same id
npm run db:migrate:local
npm run dev                      # full stack at http://localhost:5173
```

Outside Telegram there's no initData, so the Worker authenticates you as `DEV_USER_ID`
(`.dev.vars` only — never set in production). Voice transcription needs `wrangler login`,
since Workers AI has no local simulator.

`npm run check` typechecks app, worker, and config.
`npm test` runs the worker tests (Node 22.5+).

## CI and automatic deploys

`.github/workflows/ci.yml` runs the typecheck and tests on every PR and on `main`.

Deploys are done by Cloudflare Workers Builds (Worker → Settings → Build, connected to this
repo): every push to `main` runs `npm run build` then `npx wrangler deploy`. The Vite plugin
writes `.wrangler/deploy/config.json`, so plain `wrangler deploy` picks up the built config.
Worker secrets set with `wrangler secret put` are not touched by deploys.

Database migrations are not applied automatically; run `npm run db:migrate` by hand when
`migrations/` changes.
