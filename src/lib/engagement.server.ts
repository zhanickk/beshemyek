import type { SupabaseClient } from "@supabase/supabase-js";
import { telegram } from "@/lib/telegram.server";
import { pickSticker } from "@/lib/stickers.server";
import { isFeatureEnabled } from "@/lib/features.server";
import { generateEngagementLine } from "@/lib/engagement-ai.server";
import { buildChatHistoryContext } from "@/lib/chat-context.server";

const NABROS_TEMPLATES: Array<(name: string | null) => string> = [
  (name) => (name ? `${name}, ты жив?` : "Кто-нибудь жив там?"),
  (name) => (name ? `${name}, чё как` : "Чё как, народ"),
  () => "Тут тише чем в библиотеке, оживляемся",
  () => "Капец, чат вымер. Кто кинет что-нибудь — красавчик",
  (name) => (name ? `${name}, гоу хоть мем` : "Гоу хоть мем, а то скучно"),
  () => "Ема, соскучился по движу",
  () => "Треш какой-то — никого нет. Где все?",
  () => "Гоу кто-нибудь расскажет че происходит",
];

function inQuietHours(quietStart: number | null, quietEnd: number | null, hour: number): boolean {
  if (quietStart == null || quietEnd == null) return false;
  return quietStart < quietEnd
    ? hour >= quietStart && hour < quietEnd
    : hour >= quietStart || hour < quietEnd;
}

/** ~9:00–23:00 Astana (UTC+5) ≈ 04:00–18:00 UTC */
function isWorkingHours(hourUtc: number): boolean {
  return hourUtc >= 4 && hourUtc < 18;
}

function randomEngagementDelayMs(): number {
  return (2 + Math.random() * 4) * 3600 * 1000;
}

/** Silence threshold: 2–4h in working time; respects bot_settings if higher. */
function silenceThresholdMs(settingsMin: number | null | undefined): number {
  const configured = (settingsMin ?? 150) * 60 * 1000;
  const min2h = 120 * 60 * 1000;
  const max4h = 240 * 60 * 1000;
  return Math.min(max4h, Math.max(min2h, configured));
}

async function pickNudgeMember(admin: SupabaseClient, chatId: string) {
  const { data } = await admin
    .from("chat_members")
    .select("display_name, username, telegram_user_id, last_active_at")
    .eq("chat_id", chatId)
    .order("last_active_at", { ascending: true, nullsFirst: false })
    .limit(12);
  const pool = data ?? [];
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * Math.min(5, pool.length))];
}

export async function runEngagementTick(admin: SupabaseClient) {
  const nowHour = new Date().getUTCHours();
  const { data: chats } = await admin
    .from("chats")
    .select("id, telegram_chat_id, last_message_at, bot_settings(*)")
    .eq("is_active", true);

  for (const chat of chats ?? []) {
    try {
      await runEngagementTickForChat(admin, chat, nowHour);
    } catch (e) {
      console.error(`engagement tick failed for chat ${chat.telegram_chat_id}`, e);
    }
  }
}

async function runEngagementTickForChat(
  admin: SupabaseClient,
  chat: { id: string; telegram_chat_id: number; last_message_at: string | null },
  nowHour: number,
) {
  const s: any = Array.isArray((chat as any).bot_settings)
    ? (chat as any).bot_settings[0]
    : (chat as any).bot_settings;
  if (!s) return;
  if (s.is_paused) return;
  if (!(await isFeatureEnabled(admin, chat.id, "random_triggers"))) return;

  const quiet = inQuietHours(s.quiet_start, s.quiet_end, nowHour);
  const working = isWorkingHours(nowHour);
  const now = Date.now();

  if (s.paused_until && new Date(s.paused_until).getTime() <= now) {
    await admin
      .from("bot_settings")
      .update({
        paused_until: null,
        ignored_pout_sent: false,
        last_bot_message_at: new Date().toISOString(),
      })
      .eq("id", s.id);
    if (!quiet && working) {
      await telegram.sendChatAction(chat.telegram_chat_id, "typing");
      await telegram.sendMessage(chat.telegram_chat_id, "я обратно. че как, соскучились?");
    }
    return;
  }
  if (s.paused_until) return;

  const lastBotAt = s.last_bot_message_at ? new Date(s.last_bot_message_at).getTime() : 0;
  const lastHumanAt = chat.last_message_at ? new Date(chat.last_message_at).getTime() : 0;
  const silenceMs = silenceThresholdMs(s.silence_threshold_min);

  const botSpokeLast = lastBotAt > 0 && lastBotAt >= lastHumanAt;
  const silentFor = now - Math.max(lastBotAt, lastHumanAt);

  if (botSpokeLast && silentFor > silenceMs && !s.ignored_pout_sent && !quiet && working) {
    await telegram.sendChatAction(chat.telegram_chat_id, "typing");
    await telegram.sendMessage(chat.telegram_chat_id, "о бож, меня все игнорят 😔");
    const sticker = await pickSticker(admin, "обида");
    if (sticker) await telegram.sendSticker(chat.telegram_chat_id, sticker);
    await telegram.sendMessage(chat.telegram_chat_id, "Beshemyek Bratan вышел из чата.");
    const pauseMs = (20 + Math.random() * 20) * 60 * 1000;
    await admin
      .from("bot_settings")
      .update({ ignored_pout_sent: true, paused_until: new Date(now + pauseMs).toISOString() })
      .eq("id", s.id);
    return;
  }

  // Silence breaker: 2–4h no human messages during working hours
  if (!botSpokeLast && silentFor > silenceMs && !quiet && working) {
    const member = await pickNudgeMember(admin, chat.id);
    const name = member?.display_name || (member?.username ? `@${member.username}` : null);
    const text =
      Math.random() < 0.65
        ? await generateEngagementLine("silence", { memberName: name })
        : NABROS_TEMPLATES[Math.floor(Math.random() * NABROS_TEMPLATES.length)](name);
    await telegram.sendChatAction(chat.telegram_chat_id, "typing");
    await telegram.sendMessage(chat.telegram_chat_id, text);
    await admin
      .from("bot_settings")
      .update({ last_bot_message_at: new Date().toISOString() })
      .eq("id", s.id);
    return;
  }

  const nextAt = s.next_engagement_at ? new Date(s.next_engagement_at).getTime() : 0;
  if (nextAt && now >= nextAt && !quiet && working) {
    const member = await pickNudgeMember(admin, chat.id);
    const name = member?.display_name || (member?.username ? `@${member.username}` : null);
    const text =
      Math.random() < 0.5
        ? await generateEngagementLine("nabros", { memberName: name })
        : NABROS_TEMPLATES[Math.floor(Math.random() * NABROS_TEMPLATES.length)](name);
    await telegram.sendChatAction(chat.telegram_chat_id, "typing");
    await telegram.sendMessage(chat.telegram_chat_id, text);
    await admin
      .from("bot_settings")
      .update({
        last_bot_message_at: new Date().toISOString(),
        next_engagement_at: new Date(now + randomEngagementDelayMs()).toISOString(),
      })
      .eq("id", s.id);
  } else if (!nextAt) {
    await admin
      .from("bot_settings")
      .update({ next_engagement_at: new Date(now + randomEngagementDelayMs()).toISOString() })
      .eq("id", s.id);
  }
}

const CHIME_IN_COOLDOWN_MS = 25 * 60 * 1000;
const CHIME_IN_PROBABILITY = 0.04;

/** Rare organic chime-in when chat is active without @mentioning the bot. */
export async function tryOrganicChimeIn(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  settings: { id: string; last_bot_message_at?: string | null; ai_replies_enabled?: boolean | null },
): Promise<void> {
  if (!(settings.ai_replies_enabled ?? true)) return;
  if (!(await isFeatureEnabled(admin, chatId, "random_triggers"))) return;

  const hourUtc = new Date().getUTCHours();
  if (!isWorkingHours(hourUtc)) return;

  const lastBot = settings.last_bot_message_at ? new Date(settings.last_bot_message_at).getTime() : 0;
  if (Date.now() - lastBot < CHIME_IN_COOLDOWN_MS) return;
  if (Math.random() > CHIME_IN_PROBABILITY) return;

  const since = new Date(Date.now() - 12 * 60 * 1000).toISOString();
  const { count } = await admin
    .from("messages_log")
    .select("update_id", { count: "exact", head: true })
    .eq("telegram_chat_id", telegramChatId)
    .gte("created_at", since)
    .neq("kind", "command");
  if ((count ?? 0) < 3) return;

  const snippet = await buildChatHistoryContext(admin, telegramChatId, {
    messageLimit: 12,
    botLimit: 2,
  });
  if (!snippet) return;

  const line = await generateEngagementLine("chime_in", { chatSnippet: snippet });
  if (line === "SKIP" || !line.trim()) return;

  await telegram.sendChatAction(telegramChatId, "typing");
  await telegram.sendMessage(telegramChatId, line);
  await admin
    .from("bot_settings")
    .update({ last_bot_message_at: new Date().toISOString() })
    .eq("id", settings.id);
  await admin
    .from("bot_sends")
    .insert({ telegram_chat_id: telegramChatId, kind: "ai_reply", content: line });
}
