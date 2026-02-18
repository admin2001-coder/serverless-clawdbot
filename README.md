# ZeroClaw/OpenClaw → Vercel Workflow conversion (Gateway + Autonomous Daemon)

This repo is a **serverless-friendly** “1:1 conversion” starter that keeps the same UI conventions
(**Telegram**, **WhatsApp Cloud API**, **Textbelt SMS**) while replacing the always-on daemon with:

- **One public Gateway route**: `app/api/claw/route.ts`
- **Durable queues + autonomy** using **Workflow DevKit** (`"use workflow"` / `"use step"`)
- **Composio** for integrations (optional, filterable)
- **Optional SSH tool** (strongly restricted by allowlist)

## What you get

- `/health` → redirects to `/api/claw?op=health`
- `/pair` → redirects to `/api/claw?op=pair`
- `/webhook` → redirects to `/api/claw?op=webhook` (internal send/schedule endpoint)
- `/telegram` → Telegram webhook endpoint
- `/whatsapp` → WhatsApp Cloud API webhook endpoint (GET verify + POST messages)
- `/sms` → Textbelt SMS reply webhook endpoint (JSON)

> ⚠️ Vercel Cron does **not** support 1-second schedules.
> We use **Workflow sleep("1s")** in `daemonWorkflow()` and a **1-minute Cron watchdog** to ensure it’s running.

---

## Quick start

```bash
npm install
cp .env.example .env.local
npm run dev
```

### Storage (required for pairing + scheduled tasks)

Use **Upstash Redis** (recommended) or Vercel-injected Redis variables.

Set either:

- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, **or**
- `KV_REST_API_URL` + `KV_REST_API_TOKEN`

If no Redis env vars are set, the app falls back to an **in-memory store** (works locally only, not durable).

---

## Telegram setup

1) Create a bot with BotFather, set `TELEGRAM_BOT_TOKEN`.
2) Optional webhook secret: set `TELEGRAM_WEBHOOK_SECRET`.
3) Set webhook URL to:

```
https://YOUR_DOMAIN/telegram
```

If using a secret, set Telegram webhook with secret token so the gateway validates it.

---

## WhatsApp Cloud API setup

Set:
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`

Configure Meta webhook callback URL to:

```
https://YOUR_DOMAIN/whatsapp
```

---

## Textbelt SMS setup

Set:

Configure Messaging webhook to:

```
https://YOUR_DOMAIN/sms
```

---

## Pairing / allowlist behavior

Default is "locked":
- Unknown senders receive a pairing code and must reply with:
  - `/pair <CODE>`

To auto-allow admin identities, set:

```
ADMIN_IDENTITIES=telegram:123456789,sms:+15551234567,whatsapp:+15551234567
```

---

## Internal webhook

POST to:

```
/webhook  (redirects to /api/claw?op=webhook)
```

Headers:
- `x-claw-secret: <INTERNAL_WEBHOOK_SECRET>`

Body example:

```json
{
  "action": "send",
  "channel": "telegram",
  "sessionId": "telegram:123456",
  "text": "hello from webhook"
}
```

---

## Autonomy knobs

`AUTONOMOUS_MODE`:
- `assistive` (default): agent instructed to avoid destructive actions unless requested
- `full`: agent can act more freely (use with caution)

---

## Workflow UI (optional)

Run:

```bash
npm run workflow:web
```

This opens the Workflow DevKit UI locally so you can inspect runs/logs.



---

## ZeroClaw-style Gateway API (1:1 endpoints)

This starter also implements the ZeroClaw gateway endpoints:

- `GET /health` (public)
- `POST /pair` with header `X-Pairing-Code` → returns a bearer token
- `POST /webhook` with `Authorization: Bearer <token>` → triggers an agent message delivery

### Pairing code on Vercel

Because Vercel is serverless, there is no single permanent "startup".
This template generates the one-time 6-digit pairing code the first time it needs it, stores it in Redis, and logs it:

- Look in **Vercel Function Logs** for: `Pairing code generated: 123456`

### /pair example

```bash
curl -X POST https://YOUR_DOMAIN/pair \
  -H 'X-Pairing-Code: 123456'
```

Response:

```json
{ "ok": true, "token": "..." }
```

### /webhook example (deliver to last chat)

```bash
curl -X POST https://YOUR_DOMAIN/webhook \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Remind me to review PRs in 20 minutes"}'
```

By default, this delivers the agent run to the **last active chat session** (Telegram/WhatsApp/SMS) seen by the gateway.

### Channel allowlists (optional, OpenClaw-like)

If you set any of these env vars, **they override pairing** for that channel:

- `TELEGRAM_ALLOWED_USERS=123456789,*`
- `WHATSAPP_ALLOWED_NUMBERS=+15551234567`
- `SMS_ALLOWED_NUMBERS=+15551234567`

Rules:
- empty list = deny all
- `*` = allow all
- otherwise = exact match



## Admin UI

Visit `/ui` to configure webhooks, send test messages, and connect Composio integrations.

Set `ADMIN_UI_PASSWORD` first.
# serverless-clawdbot
