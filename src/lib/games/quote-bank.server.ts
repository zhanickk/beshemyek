import { generateText } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";
import type { CringeMode } from "./cringe.server";

export type QuotePool = "shared" | "who_said" | "cringe" | "auto";

const POOLS_FOR_MODE: Record<CringeMode, QuotePool[]> = {
  cringe: ["cringe", "shared"],
  who_said: ["who_said", "shared", "auto"],
};

const CHAT_SCAN_LIMIT = 800;
const TARGET_POOL_SIZE = 20;
const STALE_RECYCLE_MS = 24 * 3600 * 1000;

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
  limit = CHAT_SCAN_LIMIT,
): Promise<ChatMsg[]> {
  const { data } = await admin
    .from("messages_log")
    .select("text, from_user_id, from_username, kind, created_at")
    .eq("telegram_chat_id", telegramChatId)
    .not("text", "is", null)
    .neq("kind", "command")
    .order("created_at", { ascending: false })
    .limit(limit);

  const seen = new Set<string>();
  return (data ?? [])
    .filter((m) => {
      const text = m.text?.trim();
      if (!text || !m.from_user_id) return false;
      if (text.startsWith("/")) return false;
      if (/^@\w+\s*$/.test(text)) return false;
      const key = normalizeQuote(text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((m) => ({
      text: m.text!.trim(),
      from_user_id: m.from_user_id,
      from_username: m.from_username,
      created_at: m.created_at,
    }));
}

function heuristicScore(text: string): number {
  const t = text.trim();
  if (t.length < 10 || t.length > 360) return 0;
  if (/^https?:\/\//i.test(t)) return 0;
  if (/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u.test(t)) return 0;
  if (/^(ок|да|нет|ага|угу|лол|хах|\+1)$/i.test(t)) return 0;

  let score = 0;
  if (t.length >= 16 && t.length <= 200) score += 2;
  if (/[!?…]/.test(t)) score += 2;
  if (
    /\b(ору|жиза|кринж|угар|треш|капец|база|реально|чел|бро|ема|пиздец|ахах|лол|жесть|офиг|дичь|зашквар|рофл|угарн|топ|гений|мда|блин)\b/i.test(
      t,
    )
  )
    score += 3;
  if (/\?/.test(t)) score += 1;
  if (t.split(/\s+/).length >= 3) score += 1;
  if (/[А-ЯЁ]{3,}/.test(t)) score += 1;
  return score;
}

async function pickQuotesWithAi(
  messages: ChatMsg[],
  existing: Set<string>,
  maxPicks: number,
): Promise<Array<{ text: string; userId: number }>> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return [];

  const candidates = messages
    .map((m, i) => ({ ...m, idx: i, score: heuristicScore(m.text) }))
    .filter((m) => m.score > 0 && !existing.has(normalizeQuote(m.text)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 120);

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
        "Выбирай только реальные живые фразы — угар, кринж, мемность, неожиданность, странные мысли. " +
        "Без команд бота, ссылок и служебного шума. Разнообразие важнее: не бери похожие по смыслу.",
      prompt:
        `Из списка ниже выбери до ${maxPicks} лучших РАЗНЫХ цитат для игры. ` +
        `Верни ТОЛЬКО JSON-массив чисел (индексы строк), без markdown.\n` +
        `Пример: [12,45,3]\n\n${numbered}`,
    });

    const match = raw?.match(/\[[\d,\s]+\]/);
    if (!match) return [];
    const indices: number[] = JSON.parse(match[0]);
    const out: Array<{ text: string; userId: number }> = [];
    const pickedNorm = new Set<string>();
    for (const idx of indices) {
      const row = candidates.find((c) => c.idx === idx);
      if (!row) continue;
      const norm = normalizeQuote(row.text);
      if (existing.has(norm) || pickedNorm.has(norm)) continue;
      pickedNorm.add(norm);
      out.push({ text: row.text, userId: row.from_user_id! });
      if (out.length >= maxPicks) break;
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
  max = 20,
): Array<{ text: string; userId: number }> {
  const pickedNorm = new Set<string>();
  const out: Array<{ text: string; userId: number }> = [];
  for (const m of messages
    .map((msg) => ({ ...msg, score: heuristicScore(msg.text) }))
    .filter((msg) => msg.score > 0 && msg.from_user_id)
    .sort((a, b) => b.score - a.score)) {
    const norm = normalizeQuote(m.text);
    if (existing.has(norm) || pickedNorm.has(norm)) continue;
    pickedNorm.add(norm);
    out.push({ text: m.text, userId: m.from_user_id! });
    if (out.length >= max) break;
  }
  return out;
}

async function loadExistingQuoteNorms(admin: SupabaseClient, chatId: string): Promise<Set<string>> {
  const { data: existingRows } = await admin
    .from("cringe_entries")
    .select("quote_text")
    .eq("chat_id", chatId)
    .eq("is_active", true);
  return new Set((existingRows ?? []).map((r) => normalizeQuote(r.quote_text)));
}

/** Scan chat history and add fresh quotes for who_said / shared pool. */
export async function harvestQuotesFromChat(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  opts?: { minToAdd?: number; maxToAdd?: number; messageLimit?: number },
): Promise<number> {
  const minToAdd = opts?.minToAdd ?? 5;
  const maxToAdd = opts?.maxToAdd ?? 25;
  const messageLimit = opts?.messageLimit ?? CHAT_SCAN_LIMIT;

  const existing = await loadExistingQuoteNorms(admin, chatId);
  const messages = await loadRecentChatMessages(admin, telegramChatId, messageLimit);

  if (messages.length < 5) return 0;

  let picks = await pickQuotesWithAi(messages, existing, Math.min(15, maxToAdd));
  if (picks.length < minToAdd) {
    const more = pickQuotesHeuristic(messages, existing, maxToAdd);
    for (const p of more) {
      const norm = normalizeQuote(p.text);
      if (existing.has(norm) || picks.some((x) => normalizeQuote(x.text) === norm)) continue;
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

async function recycleStaleQuotes(
  admin: SupabaseClient,
  chatId: string,
  pools: QuotePool[],
): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RECYCLE_MS).toISOString();
  const { data } = await admin
    .from("cringe_entries")
    .update({ is_used: false, used_at: null })
    .eq("chat_id", chatId)
    .eq("is_active", true)
    .in("pool", pools)
    .eq("is_used", true)
    .lt("used_at", cutoff)
    .select("id");
  return data?.length ?? 0;
}

/** Top up quote bank from chat while group is active (rate-limited). */
export async function maybeHarvestQuotesInBackground(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
): Promise<void> {
  const available = await countAvailableQuotes(admin, chatId, "who_said");
  if (available >= TARGET_POOL_SIZE) return;

  const since = new Date(Date.now() - 8 * 60 * 1000).toISOString();
  const { count: recentAuto } = await admin
    .from("cringe_entries")
    .select("id", { count: "exact", head: true })
    .eq("chat_id", chatId)
    .eq("pool", "auto")
    .gte("created_at", since);
  if ((recentAuto ?? 0) >= 8) return;

  await harvestQuotesFromChat(admin, chatId, telegramChatId, {
    minToAdd: 2,
    maxToAdd: 6,
  });
}

/** Ensure enough unused quotes before starting a round (mines chat if needed). */
export async function ensureQuoteBank(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  mode: CringeMode,
  minAvailable = 8,
): Promise<void> {
  const pools = poolsForMode(mode);
  let available = await countAvailableQuotes(admin, chatId, mode);

  if (mode === "who_said") {
    const added = await harvestQuotesFromChat(admin, chatId, telegramChatId, {
      minToAdd: Math.max(8, minAvailable - available + 5),
      maxToAdd: 25,
    });
    available += added;
  }

  if (available >= minAvailable) return;

  await recycleStaleQuotes(admin, chatId, pools);
  available = await countAvailableQuotes(admin, chatId, mode);
  if (available >= minAvailable) return;

  if (mode === "who_said") {
    const added = await harvestQuotesFromChat(admin, chatId, telegramChatId, {
      minToAdd: minAvailable,
      maxToAdd: 30,
      messageLimit: CHAT_SCAN_LIMIT,
    });
    available += added;
  }

  if (available > 0) return;

  const { data: used } = await admin
    .from("cringe_entries")
    .select("id, used_at")
    .eq("chat_id", chatId)
    .eq("is_active", true)
    .in("pool", pools)
    .eq("is_used", true)
    .order("used_at", { ascending: true, nullsFirst: true })
    .limit(Math.max(5, minAvailable));

  if (used?.length) {
    await admin
      .from("cringe_entries")
      .update({ is_used: false, used_at: null })
      .in(
        "id",
        used.map((r) => r.id),
      );
  }
}

export async function fetchQuoteEntry(
  admin: SupabaseClient,
  chatId: string,
  mode: CringeMode,
) {
  const pools = poolsForMode(mode);

  const { data: fresh } = await admin
    .from("cringe_entries")
    .select("*")
    .eq("chat_id", chatId)
    .eq("is_active", true)
    .eq("is_used", false)
    .in("pool", pools)
    .order("used_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(30);

  let entries = fresh ?? [];
  if (!entries.length) return null;

  const pool = entries.slice(0, Math.min(12, entries.length));
  const entry = pool[Math.floor(Math.random() * pool.length)];

  await admin
    .from("cringe_entries")
    .update({ is_used: true, used_at: new Date().toISOString() })
    .eq("id", entry.id);
  return entry;
}
