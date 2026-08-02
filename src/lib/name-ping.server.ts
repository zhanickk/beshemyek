import type { SupabaseClient } from "@supabase/supabase-js";
import { telegram, type Lang } from "@/lib/telegram.server";
import { generateAiReply, DEFAULT_AI_TONE } from "@/lib/ai-reply.server";
import { buildChatHistoryContext } from "@/lib/chat-context.server";

const IDLE_LIMIT = 10;

const BESHEMYEK_NAME_RE = /беш(?:ем|м)[ьъ]?[еэ]?к|beshe?m[ye]?k|beshmek/i;

export interface NamePingState {
  userId: number;
  otherMessages: number;
}

function parseNamePingState(raw: unknown): NamePingState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.userId !== "number") return null;
  return {
    userId: o.userId,
    otherMessages: typeof o.otherMessages === "number" ? o.otherMessages : 0,
  };
}

export function matchesBeshemyekName(text: string): boolean {
  return BESHEMYEK_NAME_RE.test(text);
}

async function saveNamePingState(
  admin: SupabaseClient,
  settingsId: string,
  state: NamePingState | null,
) {
  await admin
    .from("bot_settings")
    .update({ name_ping_state: state })
    .eq("id", settingsId);
}

async function sendNamePingReply(
  admin: SupabaseClient,
  opts: {
    settingsId: string;
    telegramChatId: number;
    messageId: number;
    text: string;
    tone: string;
    lang: Lang;
  },
) {
  const chatHistory = await buildChatHistoryContext(admin, opts.telegramChatId);
  await telegram.sendChatAction(opts.telegramChatId, "typing");
  const reply = await generateAiReply(opts.text, opts.tone, opts.lang, chatHistory);
  await telegram.sendMessage(opts.telegramChatId, reply, {
    reply_to_message_id: opts.messageId,
  });
  await admin.from("bot_sends").insert({
    telegram_chat_id: opts.telegramChatId,
    kind: "ai_reply",
    content: reply,
  });
  await admin
    .from("bot_settings")
    .update({ last_bot_message_at: new Date().toISOString() })
    .eq("id", opts.settingsId);
}

export async function handleNamePingConversation(
  admin: SupabaseClient,
  opts: {
    telegramChatId: number;
    settings: {
      id: string;
      tone?: string | null;
      ai_replies_enabled?: boolean | null;
      name_ping_state?: unknown;
    };
    message: { message_id: number; from?: { id: number; is_bot?: boolean; username?: string | null }; reply_to_message?: { from?: { is_bot?: boolean } } };
    text: string;
    lang: Lang;
    mentionsBot: boolean;
  },
): Promise<boolean> {
  if (opts.mentionsBot) return false;
  if (!(opts.settings.ai_replies_enabled ?? true)) return false;
  if (!opts.text.trim() || !opts.message.from || opts.message.from.is_bot) return false;

  const tone = opts.settings.tone ?? DEFAULT_AI_TONE;
  const state = parseNamePingState(opts.settings.name_ping_state);
  const userId = opts.message.from.id;
  const isNameCall = matchesBeshemyekName(opts.text);
  const isPartner = state?.userId === userId;

  if (isNameCall) {
    await sendNamePingReply(admin, {
      settingsId: opts.settings.id,
      telegramChatId: opts.telegramChatId,
      messageId: opts.message.message_id,
      text: opts.text,
      tone,
      lang: opts.lang,
    });
    await saveNamePingState(admin, opts.settings.id, { userId, otherMessages: 0 });
    return true;
  }

  // Keep chatting with whoever pinged the name, until IDLE_LIMIT other messages pass.
  if (isPartner && state) {
    await sendNamePingReply(admin, {
      settingsId: opts.settings.id,
      telegramChatId: opts.telegramChatId,
      messageId: opts.message.message_id,
      text: opts.text,
      tone,
      lang: opts.lang,
    });
    await saveNamePingState(admin, opts.settings.id, { userId: state.userId, otherMessages: 0 });
    return true;
  }

  if (state) {
    const otherMessages = state.otherMessages + 1;
    if (otherMessages >= IDLE_LIMIT) {
      await saveNamePingState(admin, opts.settings.id, null);
    } else {
      await saveNamePingState(admin, opts.settings.id, {
        userId: state.userId,
        otherMessages,
      });
    }
  }

  return false;
}
