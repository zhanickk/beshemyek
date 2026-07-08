import { generateText } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";
import type { CringeMode } from "./cringe.server";

export type QuotePool = "shared" | "who_said" | "cringe" | "auto";

const POOLS_FOR_MODE: Record<CringeMode, QuotePool[]> = {
  cringe: ["cringe", "shared"],
  who_said: ["who_said", "shared", "auto"],
};

function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function poolsForMode(mode: CringeMode): QuotePool[] {
  return POOLS_FOR_MODE[mode];
}

export async function countAvailableQuotes(
  admin: SupabaseClient,
  chatId: string,
  mode: CringeMode,
): Promise<number> {
  const pools = poolsForMode(mode);
  const { count } = await admin
    .from("cringe_entries")
    .select("id", { count: "exact", head: true })
    .eq("chat_id", chatId)
    .eq("is_active", true)
    .eq("is_used", false)
    .in("pool", pools);
  return count ?? 0;
}

type ChatMsg = {
  text: string;
  from_user_id: number | null;
  from_username: string | null;
  created_at: string;
};

async function loadRecentChatMessages(
  admin: SupabaseClient,
  telegramChatId: number,
  limit = 400,
): Promise<ChatMsg[]> {
  const { data } = await admin
    .from("messages_log")
    .select("text, from_user_id, from_username, kind, created_at")
    .eq("telegram_chat_id", telegramChatId)
    .not("text", "is", null)
    .neq("kind", "command")
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? [])
    .filter((m) => m.text?.trim() && m.from_user_id)
    .map((m) => ({
      text: m.text!.trim(),
      from_user_id: m.from_user_id,
      from_username: m.from_username,
      created_at: m.created_at,
    }));
}

function heuristicScore(text: string): number {
  const t = text.trim();
  if (t.length < 12 || t.length > 320) return 0;
  if (/^https?:\/\//i.test(t)) return 0;
  if (/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u.test(t)) return 0;

  let score = 0;
  if (t.length >= 20 && t.length <= 180) score += 2;
  if (/[!?…]/.test(t)) score += 2;
  if (/\b(ору|жиза|кринж|угар|треш|капец|база|реально|чел|бро|ема|пиздец|ахах|лол)\b/i.test(t))
    score += 3;
  if (/\?/.test(t)) score += 1;
  if (t.split(/\s+/).length >= 4) score += 1;
  return score;
}

async function pickQuotesWithAi(
  messages: ChatMsg[],
  existing: Set<string>,
): Promise<Array<{ text: string; userId: number }>> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return [];

  const candidates = messages
    .map((m, i) => ({ ...m, idx: i, score: heuristicScore(m.text) }))
    .filter((m) => m.score > 0 && !existing.has(normalizeQuote(m.text)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 60);

  if (candidates.length < 3) return [];

  const numbered = candidates
    .map((m) => `${m.idx}. ${m.from_username ? `@${m.from_username}` : `#${m.from_user_id}`}: ${m.text}`)
    .join("\n");

  try {
    const provider = createDeepSeekProvider(key);
    const { text: raw } = await generateText({
      model: provider(getDeepSeekModel()),
      system:
        "Ты помогаешь локалке AIESEC собрать смешные/запоминающиеся цитаты из чата для игры «Кто это сказал». " +
        "Выбирай только реальные живые фразы — угар, кринж, мемность, неожиданность. Без команд бота и служебного шума.",
      prompt:
        `Из списка ниже выбери до 8 лучших цитат для игры. Верни ТОЛЬКО JSON-массив чисел (индексы строк), без markdown.\n` +
        `Пример: [12,45,3]\n\n${numbered}`,
    });

    const match = raw?.match(/\[[\d,\s]+\]/);
    if (!match) return [];
    const indices: number[] = JSON.parse(match[0]);
    const out: Array<{ text: string; userId: number }> = [];
    for (const idx of indices) {
      const row = candidates.find((c) => c.idx === idx);
      if (!row || existing.has(normalizeQuote(row.text))) continue;
      out.push({ text: row.text, userId: row.from_user_id! });
      if (out.length >= 8) break;
    }
    return out;
  } catch (e) {
    console.error("pickQuotesWithAi failed", e);
    return [];
  }
}

function pickQuotesHeuristic(
  messages: ChatMsg[],
  existing: Set<string>,
  max = 8,
): Array<{ text: string; userId: number }> {
  return messages
    .map((m) => ({ ...m, score: heuristicScore(m.text) }))
    .filter((m) => m.score > 0 && m.from_user_id && !existing.has(normalizeQuote(m.text)))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((m) => ({ text: m.text, userId: m.from_user_id! }));
}

/** Scan chat history and add fresh quotes for who_said / shared pool. */
export async function harvestQuotesFromChat(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  opts?: { minToAdd?: number; maxToAdd?: number },
): Promise<number> {
  const minToAdd = opts?.minToAdd ?? 3;
  const maxToAdd = opts?.maxToAdd ?? 10;

  const { data: existingRows } = await admin
    .from("cringe_entries")
    .select("quote_text")
    .eq("chat_id", chatId)
    .eq("is_active", true);

  const existing = new Set((existingRows ?? []).map((r) => normalizeQuote(r.quote_text)));
  const messages = await loadRecentChatMessages(admin, telegramChatId, 500);

  let picks = await pickQuotesWithAi(messages, existing);
  if (picks.length < minToAdd) {
    const more = pickQuotesHeuristic(messages, existing, maxToAdd);
    for (const p of more) {
      if (picks.some((x) => normalizeQuote(x.text) === normalizeQuote(p.text))) continue;
      picks.push(p);
      if (picks.length >= maxToAdd) break;
    }
  }

  if (!picks.length) return 0;

  const rows = picks.slice(0, maxToAdd).map((p) => ({
    chat_id: chatId,
    quote_text: p.text,
    telegram_user_id: p.userId,
    pool: "auto" as const,
    added_by_user_id: null,
  }));

  const { error } = await admin.from("cringe_entries").insert(rows);
  if (error) {
    console.error("harvestQuotesFromChat insert failed", error);
    return 0;
  }
  return rows.length;
}

/** Ensure enough unused quotes before starting a round (mines chat if needed). */
export async function ensureQuoteBank(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  mode: CringeMode,
  minAvailable = 5,
): Promise<void> {
  let available = await countAvailableQuotes(admin, chatId, mode);
  if (available >= minAvailable) return;

  if (mode === "who_said") {
    const added = await harvestQuotesFromChat(admin, chatId, telegramChatId, {
      minToAdd: minAvailable - available,
      maxToAdd: 12,
    });
    available += added;
  }

  if (available === 0) {
    const { data: used } = await admin
      .from("cringe_entries")
      .select("id")
      .eq("chat_id", chatId)
      .eq("is_active", true)
      .in("pool", poolsForMode(mode))
      .eq("is_used", true)
      .limit(1);
    if (used?.length) {
      await admin
        .from("cringe_entries")
        .update({ is_used: false, used_at: null })
        .eq("chat_id", chatId)
        .eq("is_active", true)
        .in("pool", poolsForMode(mode));
    }
  }
}

export async function fetchQuoteEntry(
  admin: SupabaseClient,
  chatId: string,
  mode: CringeMode,
) {
  const pools = poolsForMode(mode);
  let { data: entries } = await admin
    .from("cringe_entries")
    .select("*")
    .eq("chat_id", chatId)
    .eq("is_active", true)
    .eq("is_used", false)
    .in("pool", pools);

  if (!entries?.length) {
    await admin
      .from("cringe_entries")
      .update({ is_used: false, used_at: null })
      .eq("chat_id", chatId)
      .eq("is_active", true)
      .in("pool", pools);
    const retry = await admin
      .from("cringe_entries")
      .select("*")
      .eq("chat_id", chatId)
      .eq("is_active", true)
      .in("pool", pools);
    entries = retry.data ?? [];
  }

  if (!entries.length) return null;
  const entry = entries[Math.floor(Math.random() * entries.length)];
  await admin
    .from("cringe_entries")
    .update({ is_used: true, used_at: new Date().toISOString() })
    .eq("id", entry.id);
  return entry;
}
