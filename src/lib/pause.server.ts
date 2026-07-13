import type { SupabaseClient } from "@supabase/supabase-js";
import { telegram, type Lang } from "@/lib/telegram.server";

export const BOT_SLEEP_MESSAGES: Record<Lang, string> = {
  ru: "😴 Ой, ребятьки, чёт я устал… Пошёл спатьки.",
  en: "😴 Phew, I'm beat… Off to nap.",
};

export const BOT_WAKE_MESSAGES: Record<Lang, string> = {
  ru: "☀️ О, проснулся! Я жив, я на связи — го играть! 🎮",
  en: "☀️ I'm up! Alive and ready — let's play! 🎮",
};

/** Skip Telegram updates that were sent before the bot was resumed. */
export function isStaleTelegramDate(
  messageDateSec?: number,
  ignoreBefore?: string | null,
): boolean {
  if (!messageDateSec || !ignoreBefore) return false;
  const cutoff = new Date(ignoreBefore).getTime() - 3000;
  return messageDateSec * 1000 < cutoff;
}

export function resumeBotFields(): { is_paused: false; ignore_messages_before: string } {
  return { is_paused: false, ignore_messages_before: new Date().toISOString() };
}

export async function setBotPausedState(
  admin: SupabaseClient,
  opts: {
    settingsId: string;
    telegramChatId: number;
    paused: boolean;
    silent: boolean;
    lang?: Lang;
  },
): Promise<void> {
  const lang = opts.lang ?? "ru";
  if (opts.paused) {
    await admin.from("bot_settings").update({ is_paused: true }).eq("id", opts.settingsId);
    if (!opts.silent) {
      await telegram.sendMessage(opts.telegramChatId, BOT_SLEEP_MESSAGES[lang]);
    }
    return;
  }

  await admin.from("bot_settings").update(resumeBotFields()).eq("id", opts.settingsId);
  if (!opts.silent) {
    await telegram.sendMessage(opts.telegramChatId, BOT_WAKE_MESSAGES[lang]);
  }
}

export async function shouldDropGroupCallback(
  admin: SupabaseClient,
  telegramChatId: number,
  messageDateSec?: number,
): Promise<boolean> {
  const { data: chatRow } = await admin
    .from("chats")
    .select("id")
    .eq("telegram_chat_id", telegramChatId)
    .maybeSingle();
  if (!chatRow) return true;

  const { data: settings } = await admin
    .from("bot_settings")
    .select("is_paused, ignore_messages_before")
    .eq("chat_id", chatRow.id)
    .maybeSingle();

  if (settings?.is_paused) return true;
  return isStaleTelegramDate(messageDateSec, settings?.ignore_messages_before);
}
