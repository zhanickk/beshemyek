import type { SupabaseClient } from "@supabase/supabase-js";
import type { CringeMode } from "./cringe.server";

export type QuotePool = "shared" | "who_said" | "cringe" | "auto";

const POOLS_FOR_MODE: Record<CringeMode, QuotePool[]> = {
  cringe: ["cringe", "shared"],
  who_said: ["who_said", "shared", "auto"],
};

/** Last N chat messages to mine — keep small for fast webhook response. */
const CHAT_SCAN_LIMIT = 250;
const STALE_RECYCLE_MS = 24 * 3600 * 1000;

function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function poolsForMode(mode: CringeMode): QuotePool[] {
  return POOLS_FOR_MODE[mode];
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function isEligibleQuote(text: string): boolean {
  const t = text.trim();
  if (t.length < 8 || t.length > 400) return false;
  if (t.startsWith("/")) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^@\w+\s*$/.test(t)) return false;
  if (/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u.test(t)) return false;
  if (/^(ок|да|нет|ага|угу|\+1)$/i.test(t)) return false;
  return true;
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
  from_user_id: number;
  from_username: string | null;
};

async function loadRecentChatMessages(
  admin: SupabaseClient,
  telegramChatId: number,
  limit = CHAT_SCAN_LIMIT,
): Promise<ChatMsg[]> {
  const { data } = await admin
    .from("messages_log")
    .select("text, from_user_id, from_username, kind")
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
      if (!isEligibleQuote(text)) return false;
      const key = normalizeQuote(text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((m) => ({
      text: m.text!.trim(),
      from_user_id: m.from_user_id!,
      from_username: m.from_username,
    }));
}

async function loadExistingQuoteNorms(admin: SupabaseClient, chatId: string): Promise<Set<string>> {
  const { data: existingRows } = await admin
    .from("cringe_entries")
    .select("quote_text")
    .eq("chat_id", chatId)
    .eq("is_active", true);
  return new Set((existingRows ?? []).map((r) => normalizeQuote(r.quote_text)));
}

function pickQuotesRandom(
  messages: ChatMsg[],
  existing: Set<string>,
  max: number,
): Array<{ text: string; userId: number }> {
  const out: Array<{ text: string; userId: number }> = [];
  const picked = new Set<string>();
  for (const m of shuffle(messages)) {
    const norm = normalizeQuote(m.text);
    if (existing.has(norm) || picked.has(norm)) continue;
    picked.add(norm);
    out.push({ text: m.text, userId: m.from_user_id });
    if (out.length >= max) break;
  }
  return out;
}

/** Fast random quote straight from recent chat (no AI, no batch insert). */
export async function pickLiveQuoteFromChat(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
): Promise<{ text: string; userId: number } | null> {
  const existing = await loadExistingQuoteNorms(admin, chatId);
  const messages = await loadRecentChatMessages(admin, telegramChatId);
  const pick = pickQuotesRandom(messages, existing, 1)[0];
  return pick ?? null;
}

/** Scan chat history and add random quotes (lightweight, no AI). */
export async function harvestQuotesFromChat(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  opts?: { maxToAdd?: number },
): Promise<number> {
  const maxToAdd = opts?.maxToAdd ?? 5;
  const existing = await loadExistingQuoteNorms(admin, chatId);
  const messages = await loadRecentChatMessages(admin, telegramChatId);
  if (messages.length < 3) return 0;

  const picks = pickQuotesRandom(messages, existing, maxToAdd);
  if (!picks.length) return 0;

  const { error } = await admin.from("cringe_entries").insert(
    picks.map((p) => ({
      chat_id: chatId,
      quote_text: p.text,
      telegram_user_id: p.userId,
      pool: "auto" as const,
      added_by_user_id: null,
    })),
  );
  if (error) {
    console.error("harvestQuotesFromChat insert failed", error);
    return 0;
  }
  return picks.length;
}

async function recycleStaleQuotes(
  admin: SupabaseClient,
  chatId: string,
  pools: QuotePool[],
): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RECYCLE_MS).toISOString();
  await admin
    .from("cringe_entries")
    .update({ is_used: false, used_at: null })
    .eq("chat_id", chatId)
    .eq("is_active", true)
    .in("pool", pools)
    .eq("is_used", true)
    .lt("used_at", cutoff);
}

/** Quick top-up before a round — must stay fast (no AI). */
export async function ensureQuoteBank(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  mode: CringeMode,
): Promise<void> {
  const pools = poolsForMode(mode);
  let available = await countAvailableQuotes(admin, chatId, mode);
  if (available >= 3) return;

  if (mode === "who_said") {
    available += await harvestQuotesFromChat(admin, chatId, telegramChatId, { maxToAdd: 5 });
  }
  if (available >= 1) return;

  await recycleStaleQuotes(admin, chatId, pools);
}

export async function fetchQuoteEntry(
  admin: SupabaseClient,
  chatId: string,
  mode: CringeMode,
  telegramChatId?: number,
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
    .limit(40);

  const entries = fresh ?? [];
  if (entries.length) {
    const pool = shuffle(entries).slice(0, Math.min(10, entries.length));
    const entry = pool[0];
    await admin
      .from("cringe_entries")
      .update({ is_used: true, used_at: new Date().toISOString() })
      .eq("id", entry.id);
    return entry;
  }

  if (mode === "who_said" && telegramChatId) {
    const live = await pickLiveQuoteFromChat(admin, chatId, telegramChatId);
    if (!live) return null;
    const { data: inserted } = await admin
      .from("cringe_entries")
      .insert({
        chat_id: chatId,
        quote_text: live.text,
        telegram_user_id: live.userId,
        pool: "auto",
        added_by_user_id: null,
        is_used: true,
        used_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    return inserted;
  }

  const { data: used } = await admin
    .from("cringe_entries")
    .select("id")
    .eq("chat_id", chatId)
    .eq("is_active", true)
    .in("pool", pools)
    .eq("is_used", true)
    .order("used_at", { ascending: true, nullsFirst: true })
    .limit(5);

  if (used?.length) {
    await admin
      .from("cringe_entries")
      .update({ is_used: false, used_at: null })
      .in(
        "id",
        used.map((r) => r.id),
      );
    return fetchQuoteEntry(admin, chatId, mode, telegramChatId);
  }

  return null;
}
