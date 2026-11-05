import type { SupabaseClient } from "@supabase/supabase-js";
import { chatMemberTag } from "@/lib/telegram.server";

export type LedgerReason =
  | "game_win"
  | "game_loss"
  | "daily_bonus"
  | "vibe_gift"
  | "streak"
  | "shop_purchase"
  | "admin_adjust"
  | "tumba_send"
  | "chat_message";

const CHAT_MESSAGE_COINS = 2;

export function isAwardableChatMessage(text: string, message: {
  photo?: unknown;
  animation?: unknown;
  sticker?: unknown;
  video?: unknown;
  voice?: unknown;
}): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) return false;
  if (trimmed.length > 0) return true;
  return !!(message.photo || message.animation || message.sticker || message.video || message.voice);
}

export async function awardChatMessageCoins(
  admin: SupabaseClient,
  chatId: string,
  telegramUserId: number,
  messageId: number,
) {
  await awardCoins(admin, chatId, telegramUserId, CHAT_MESSAGE_COINS, "chat_message", {
    message_id: messageId,
  });
}

export async function ensureMember(
  admin: SupabaseClient,
  chatId: string,
  telegramUserId: number,
  info?: { username?: string | null; display_name?: string | null },
) {
  const { data: existing } = await admin
    .from("chat_members")
    .select("*")
    .eq("chat_id", chatId)
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  const today = new Date().toISOString().slice(0, 10);

  if (!existing) {
    const { data } = await admin
      .from("chat_members")
      .insert({
        chat_id: chatId,
        telegram_user_id: telegramUserId,
        username: info?.username ?? null,
        display_name: info?.display_name ?? null,
        message_count: 1,
        streak_days: 1,
        last_streak_date: today,
        last_active_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    return data;
  }

  const patch: Record<string, unknown> = {
    message_count: (existing.message_count ?? 0) + 1,
    last_active_at: new Date().toISOString(),
  };
  if (info?.username && info.username !== existing.username) patch.username = info.username;
  if (info?.display_name && info.display_name !== existing.display_name)
    patch.display_name = info.display_name;

  if (existing.last_streak_date !== today) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const newStreak = existing.last_streak_date === yesterday ? (existing.streak_days ?? 0) + 1 : 1;
    patch.streak_days = newStreak;
    patch.last_streak_date = today;
    if (newStreak > 1 && newStreak % 3 === 0) {
      // small streak bonus every 3rd consecutive active day
      await awardCoins(admin, chatId, telegramUserId, 10, "streak", { streak: newStreak });
    }
  }

  const { data } = await admin
    .from("chat_members")
    .update(patch)
    .eq("id", existing.id)
    .select("*")
    .single();
  return data ?? existing;
}

async function computeLedgerSum(
  admin: SupabaseClient,
  chatId: string,
  telegramUserId: number,
): Promise<number> {
  const { data: rows, error } = await admin
    .from("economy_ledger")
    .select("delta")
    .eq("chat_id", chatId)
    .eq("telegram_user_id", telegramUserId);
  if (error) throw error;
  return (rows ?? []).reduce((sum, row) => sum + row.delta, 0);
}

/**
 * Reads the canonical balance, reconciling one-time historical drift where
 * chat_members.coins was bumped directly (e.g. by legacy site code) without
 * a matching ledger row. Do NOT call this from inside a write path that just
 * touched the ledger — chat_members.coins may still be stale from before
 * that write, which would make this re-insert the delta we just applied.
 * Use `computeLedgerSum` + `syncMemberCoins` for that instead.
 */
export async function getBalance(
  admin: SupabaseClient,
  chatId: string,
  telegramUserId: number,
): Promise<number> {
  let ledger = Math.max(0, await computeLedgerSum(admin, chatId, telegramUserId));

  const { data: member } = await admin
    .from("chat_members")
    .select("id, coins")
    .eq("chat_id", chatId)
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  const stored = member?.coins ?? 0;
  if (stored > ledger) {
    const gap = stored - ledger;
    const { error: fixError } = await admin.from("economy_ledger").insert({
      chat_id: chatId,
      telegram_user_id: telegramUserId,
      delta: gap,
      reason: "admin_adjust",
      meta: { reconcile: true },
    });
    if (fixError) throw fixError;
    ledger = stored;
  } else if (member && stored !== ledger) {
    const { error: syncError } = await admin
      .from("chat_members")
      .update({ coins: ledger })
      .eq("id", member.id);
    if (syncError) throw syncError;
  }

  return ledger;
}

/**
 * Sets chat_members.coins to match the raw ledger sum after a write.
 * Intentionally does NOT go through getBalance's reconcile logic, which
 * would compare against the not-yet-updated (stale) chat_members.coins and
 * wrongly re-apply the delta we just wrote.
 */
async function syncMemberCoins(
  admin: SupabaseClient,
  chatId: string,
  telegramUserId: number,
): Promise<number> {
  const balance = Math.max(0, await computeLedgerSum(admin, chatId, telegramUserId));
  const { data: member } = await admin
    .from("chat_members")
    .select("id")
    .eq("chat_id", chatId)
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (member) {
    const { error } = await admin
      .from("chat_members")
      .update({ coins: balance })
      .eq("id", member.id);
    if (error) throw error;
  } else {
    const { error } = await admin.from("chat_members").insert({
      chat_id: chatId,
      telegram_user_id: telegramUserId,
      coins: balance,
    });
    if (error) throw error;
  }
  return balance;
}

export async function awardCoins(
  admin: SupabaseClient,
  chatId: string,
  telegramUserId: number,
  delta: number,
  reason: LedgerReason,
  meta?: Record<string, unknown>,
) {
  const { error: ledgerError } = await admin.from("economy_ledger").insert({
    chat_id: chatId,
    telegram_user_id: telegramUserId,
    delta,
    reason,
    meta,
  });
  if (ledgerError) throw ledgerError;
  await syncMemberCoins(admin, chatId, telegramUserId);
}

export async function spendCoins(
  admin: SupabaseClient,
  chatId: string,
  telegramUserId: number,
  amount: number,
  meta?: Record<string, unknown>,
): Promise<boolean> {
  const balance = await getBalance(admin, chatId, telegramUserId);
  if (balance < amount) return false;
  await awardCoins(admin, chatId, telegramUserId, -amount, "shop_purchase", meta);
  return true;
}

export async function getLeaderboard(admin: SupabaseClient, chatId: string, limit = 10) {
  const { data } = await admin
    .from("chat_members")
    .select("telegram_user_id, username, display_name, coins, streak_days")
    .eq("chat_id", chatId)
    .order("coins", { ascending: false })
    .limit(limit);
  return data ?? [];
}

export function formatLeaderboardMessage(
  top: Array<{
    telegram_user_id: number;
    username: string | null;
    display_name: string | null;
    coins: number;
  }>,
  title = "🏆 <b>Лидерборд БешКоинов</b>",
): string {
  if (!top.length) return "Лидерборд пуст.";
  const lines = top.map((m, i) => `${i + 1}. ${chatMemberTag(m)} — ${m.coins} 🪙`);
  return `${title}\n${lines.join("\n")}`;
}

export async function pickRandomMembers(
  admin: SupabaseClient,
  chatId: string,
  count: number,
  activeSinceHours = 48,
): Promise<
  Array<{ telegram_user_id: number; username: string | null; display_name: string | null }>
> {
  const since = new Date(Date.now() - activeSinceHours * 3600 * 1000).toISOString();
  const { data } = await admin
    .from("chat_members")
    .select("telegram_user_id, username, display_name")
    .eq("chat_id", chatId)
    .gte("last_active_at", since);
  const pool = data ?? [];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}
