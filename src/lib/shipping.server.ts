import type { SupabaseClient } from "@supabase/supabase-js";
import { telegram } from "@/lib/telegram.server";

function randomDelayMs() {
  return (30 + Math.random() * 90) * 60 * 1000; // 30-120 min, per spec section 4
}

function memberName(m: {
  display_name?: string | null;
  username?: string | null;
  telegram_user_id: number;
}) {
  return m.display_name || (m.username ? `@${m.username}` : `#${m.telegram_user_id}`);
}

export async function maybeStartShipping(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
) {
  const { data: activeMatch } = await admin
    .from("shipping_matches")
    .select("id")
    .eq("chat_id", chatId)
    .neq("status", "expired")
    .gte("started_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .maybeSingle();
  if (activeMatch) return;

  const candidates = (
    await admin
      .from("chat_members")
      .select("telegram_user_id, username, display_name")
      .eq("chat_id", chatId)
      .eq("shipping_opt_in", true)
      .gte("last_active_at", new Date(Date.now() - 48 * 3600 * 1000).toISOString())
  ).data;
  if (!candidates || candidates.length < 2) return;

  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  const [a, b] = shuffled;

  await admin.from("shipping_matches").insert({
    chat_id: chatId,
    user_a: a.telegram_user_id,
    user_b: b.telegram_user_id,
    stage: 0,
    status: "active",
    next_step_at: new Date().toISOString(),
  });

  await telegram.sendChatAction(telegramChatId, "typing");
  await telegram.sendMessage(
    telegramChatId,
    "Так, стоять... мой радар зафиксировал жёсткие флюиды в чате. Кому-то скоро прилетит ризз... 👀",
  );
}

export async function tickShipping(admin: SupabaseClient) {
  const { data: matches } = await admin
    .from("shipping_matches")
    .select("*, chats!inner(telegram_chat_id)")
    .eq("status", "active")
    .lte("next_step_at", new Date().toISOString());

  for (const match of matches ?? []) {
    try {
      await progressShippingMatch(admin, match);
    } catch (e) {
      console.error(`shipping tick failed for match ${match.id}`, e);
    }
  }
}

async function progressShippingMatch(admin: SupabaseClient, match: any) {
  const telegramChatId = (match as any).chats.telegram_chat_id;
  const { data: members } = await admin
    .from("chat_members")
    .select("telegram_user_id, username, display_name")
    .eq("chat_id", match.chat_id)
    .in("telegram_user_id", [match.user_a, match.user_b]);
  const nameA = memberName(
    members?.find((m) => m.telegram_user_id === match.user_a) ?? {
      telegram_user_id: match.user_a,
    },
  );
  const nameB = memberName(
    members?.find((m) => m.telegram_user_id === match.user_b) ?? {
      telegram_user_id: match.user_b,
    },
  );

  if (match.stage === 0) {
    await telegram.sendChatAction(telegramChatId, "typing");
    await telegram.sendMessage(
      telegramChatId,
      `Я проверил тайминги, когда ${nameA} и ${nameB} заходят в сеть. Хм, подозрительно совпадает. Совпадение? Не думаю. 🕵️`,
    );
    await admin
      .from("shipping_matches")
      .update({ stage: 1, next_step_at: new Date(Date.now() + randomDelayMs()).toISOString() })
      .eq("id", match.id);
  } else if (match.stage === 1) {
    await telegram.sendChatAction(telegramChatId, "typing");
    await telegram.sendMessage(
      telegramChatId,
      `Короче, я всё решил. ${nameA} и ${nameB}, когда свадьба на конфе? Горько, скибиди доп доп ес ес! Камон, признавайтесь. 💍`,
    );
    await admin
      .from("shipping_matches")
      .update({ stage: 2, status: "revealed", next_step_at: new Date().toISOString() })
      .eq("id", match.id);
  }
}

/** Rolls a small per-minute chance to kick off a fresh shipping match in each eligible chat. */
export async function runShippingStartTick(admin: SupabaseClient) {
  const { data: chats } = await admin
    .from("chats")
    .select("id, telegram_chat_id")
    .eq("is_active", true);

  for (const chat of chats ?? []) {
    try {
      if (Math.random() > 1 / 240) continue; // ~once every 4h on average per eligible chat
      const { isFeatureEnabled } = await import("@/lib/features.server");
      if (!(await isFeatureEnabled(admin, chat.id, "shipping"))) continue;
      await maybeStartShipping(admin, chat.id, chat.telegram_chat_id);
    } catch (e) {
      console.error(`shipping start tick failed for chat ${chat.telegram_chat_id}`, e);
    }
  }
}
