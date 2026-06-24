## Goal
A Telegram bot that keeps group chats lively (icebreaker prompts, AI replies when mentioned, polls/mini-games) plus a web dashboard to configure it and see activity.

## Setup
1. Enable **Lovable Cloud** (database, auth, server runtime).
2. Connect the **Telegram** connector (provides bot credentials via the connector gateway — no token pasting).
3. Email/password + Google login for dashboard access. First signed-up user becomes admin via a `user_roles` table.

## Database (Lovable Cloud)
- `chats` — Telegram chats the bot has been added to (chat_id, title, joined_at, is_active).
- `bot_settings` — per-chat config: tone, prompt frequency, enabled features (icebreakers/AI/polls), quiet hours.
- `prompts` — pool of icebreaker/conversation-starter prompts (text, category, active).
- `messages_log` — incoming updates (update_id PK for idempotency, chat_id, user, text, kind).
- `bot_sends` — outgoing messages (chat_id, kind: prompt|ai_reply|poll, content, sent_at).
- `polls` — active mini-game/poll state (chat_id, question, options, started_at, closes_at).
- `schedules` — pg_cron jobs registry view (for daily prompt firing).

All tables: explicit GRANTs + RLS. Admins only via `has_role(auth.uid(),'admin')`.

## Server endpoints
- `POST /api/public/telegram/webhook` — receives Telegram updates (verifies `X-Telegram-Bot-Api-Secret-Token` derived from connector key). Stores update, then routes:
  - `/start`, bot added → register chat, send welcome.
  - Mention or reply to bot → call Lovable AI (Gemini flash) with a **kind, supportive community-host** persona, reply in-thread.
  - Poll answers → tally in `polls`.
- `POST /api/public/cron/daily-prompt` — pg_cron hits this hourly; for each active chat whose schedule matches, picks a random prompt and sends it via the Telegram gateway. Secured with a shared secret.
- Server functions (auth-gated): list chats, update settings, CRUD prompts, send-now, create poll, fetch activity stats.

## AI replies
- Lovable AI Gateway via AI SDK (`google/gemini-3-flash-preview`).
- System prompt: "You are a kind, encouraging community host. Keep replies short (1–3 sentences), warm, inclusive, never sarcastic. Ask a gentle follow-up question to keep conversation going."
- Triggered only on @mention or reply-to-bot to avoid spam.

## Mini-games
- `/poll question | opt1 | opt2 | …` admin command → uses Telegram `sendPoll`.
- `/trivia` → bot fetches a question via AI in JSON schema (question + 4 options + answer index), sends as poll, reveals answer after timer.
- `/icebreaker` → posts a random prompt immediately.

## Dashboard (TanStack routes under `_authenticated/`)
- `/` landing → redirect to `/dashboard`.
- `/auth` — email+password + Google.
- `/dashboard` — overview cards: active chats, messages today, prompts sent, AI replies.
- `/chats` — list of chats; per chat: toggle features, set prompt frequency (off/daily/twice daily/hourly), quiet hours, "Send prompt now", "Start trivia".
- `/prompts` — manage prompt library (add/edit/delete, categorize).
- `/activity` — recent messages and bot sends with filters.
- `/settings` — bot persona/tone, AI on/off, setup instructions ("Add @yourbot to your group, make it admin").

## Setup helper
After deploy, a one-time admin action calls Telegram `setWebhook` via the connector gateway using the derived secret, pointing at `project--<id>-dev.lovable.app/api/public/telegram/webhook`. Dashboard shows webhook status (`getWebhookInfo`).

## Tech notes
- TanStack Start server routes + server functions.
- Telegram via connector gateway (`https://connector-gateway.lovable.dev/telegram/...`), no raw bot token in code.
- AI via Lovable AI Gateway helper.
- pg_cron schedules the daily-prompt endpoint.
- Idempotent webhook (upsert on `update_id`).

## Out of scope (ask if wanted later)
- Per-end-user OAuth, multi-tenant workspaces, paid plans, analytics export.
