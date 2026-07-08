import type { SupabaseClient } from "@supabase/supabase-js";

export type LedgerReason =
  | "game_win"
  | "game_loss"
  | "daily_bonus"
  | "vibe_gift"
  | "streak"
  | "shop_purchase"
  | "admin_adjust"
  | "tumba_send";

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

export async function awardCoins(
  admin: SupabaseClient,
  chatId: string,
  telegramUserId: number,
  delta: number,
  reason: LedgerReason,
  meta?: Record<string, unknown>,
) {
  await admin
    .from("economy_ledger")
    .insert({ chat_id: chatId, telegram_user_id: telegramUserId, delta, reason, meta });
  const { data: member } = await admin
    .from("chat_members")
    .select("id, coins")
    .eq("chat_id", chatId)
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (member) {
    await admin
      .from("chat_members")
      .update({ coins: Math.max(0, (member.coins ?? 0) + delta) })
      .eq("id", member.id);
  } else {
    await admin
      .from("chat_members")
      .insert({ chat_id: chatId, telegram_user_id: telegramUserId, coins: Math.max(0, delta) });
  }
}

export async function getBalance(
  admin: SupabaseClient,
  chatId: string,
  telegramUserId: number,
): Promise<number> {
  const { data } = await admin
    .from("chat_members")
    .select("coins")
    .eq("chat_id", chatId)
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  return data?.coins ?? 0;
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
