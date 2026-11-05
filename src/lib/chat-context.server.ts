import type { SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_MESSAGE_LIMIT = 25;
const DEFAULT_BOT_LIMIT = 8;
const MAX_CONTEXT_CHARS = 2800;

type HistoryLine = { at: string; label: string; text: string };

/** Pulls recent chat + bot messages, merges chronologically for AI memory. */
export async function buildChatHistoryContext(
  admin: SupabaseClient,
  telegramChatId: number,
  opts?: { messageLimit?: number; botLimit?: number },
): Promise<string> {
  const messageLimit = opts?.messageLimit ?? DEFAULT_MESSAGE_LIMIT;
  const botLimit = opts?.botLimit ?? DEFAULT_BOT_LIMIT;

  const [msgsRes, botRes] = await Promise.all([
    admin
      .from("messages_log")
      .select("text, from_username, from_user_id, kind, created_at")
      .eq("telegram_chat_id", telegramChatId)
      .not("text", "is", null)
      .neq("kind", "command")
      .order("created_at", { ascending: false })
      .limit(messageLimit),
    admin
      .from("bot_sends")
      .select("content, kind, sent_at")
      .eq("telegram_chat_id", telegramChatId)
      .in("kind", ["ai_reply", "prompt"])
      .not("content", "is", null)
      .order("sent_at", { ascending: false })
      .limit(botLimit),
  ]);

  const lines: HistoryLine[] = [];

  for (const m of msgsRes.data ?? []) {
    if (!m.text?.trim()) continue;
    const who = m.from_username
      ? `@${m.from_username}`
      : m.from_user_id
        ? `#${m.from_user_id}`
        : "кто-то";
    lines.push({ at: m.created_at, label: who, text: m.text.trim() });
  }
  for (const b of botRes.data ?? []) {
    if (!b.content?.trim()) continue;
    lines.push({
      at: b.sent_at,
      label: "Beshemyek",
      text: b.content.trim().replace(/<[^>]+>/g, ""),
    });
  }

  lines.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  let out = "";
  for (const line of lines) {
    const row = `${line.label}: ${line.text}\n`;
    if (out.length + row.length > MAX_CONTEXT_CHARS) break;
    out += row;
  }
  return out.trim();
}
