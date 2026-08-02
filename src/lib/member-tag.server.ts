import type { SupabaseClient } from "@supabase/supabase-js";
import { chatMemberTag, tgUserMention } from "@/lib/telegram.server";

/** Clickable member tag for group messages (never shows raw #id). */
export function playerTag(p: {
  id: number;
  name?: string | null;
  username?: string | null;
  display_name?: string | null;
}): string {
  if (p.display_name?.trim() || p.username) {
    return chatMemberTag({
      telegram_user_id: p.id,
      display_name: p.display_name?.trim() || p.name?.trim() || null,
      username: p.username ?? null,
    });
  }
  if (p.name?.trim()) {
    const label = p.name
      .trim()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<a href="tg://user?id=${p.id}">${label}</a>`;
  }
  return tgUserMention({ id: p.id });
}

export async function lookupMemberTag(
  admin: SupabaseClient,
  chatId: string,
  telegramUserId: number,
  fallback?: {
    username?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    name?: string | null;
  },
): Promise<string> {
  const { data } = await admin
    .from("chat_members")
    .select("telegram_user_id, username, display_name")
    .eq("chat_id", chatId)
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (data) return chatMemberTag(data);
  return tgUserMention({
    id: telegramUserId,
    username: fallback?.username,
    first_name: fallback?.first_name ?? fallback?.name ?? undefined,
    last_name: fallback?.last_name,
  });
}

export async function lookupMemberTags(
  admin: SupabaseClient,
  chatId: string,
  ids: number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  const map = new Map<number, string>();
  if (unique.length === 0) return map;

  const { data } = await admin
    .from("chat_members")
    .select("telegram_user_id, username, display_name")
    .eq("chat_id", chatId)
    .in("telegram_user_id", unique);

  for (const row of data ?? []) {
    map.set(row.telegram_user_id, chatMemberTag(row));
  }
  for (const id of unique) {
    if (!map.has(id)) map.set(id, tgUserMention({ id }));
  }
  return map;
}
