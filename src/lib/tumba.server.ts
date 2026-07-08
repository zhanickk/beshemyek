import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText } from "ai";
import { telegram, inlineKeyboard, buildDeepLink } from "@/lib/telegram.server";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";
import { moderateText } from "@/lib/moderation.server";
import { isFeatureEnabled } from "@/lib/features.server";

export type TumbaCategory = "confession" | "compliment" | "question" | "ship" | "ama";

const CATEGORY_LABELS: Record<TumbaCategory, string> = {
  confession: "💌 Признание",
  compliment: "✨ Комплимент",
  question: "❓ Вопрос",
  ship: "💘 Шип",
  ama: "🎤 Вопрос для EB (AMA)",
};

const THRESHOLD_MIN = 5;
const THRESHOLD_MAX = 8;

const DIGEST_HEADERS = [
  "🍬",
  "📰",
  "🗞",
  "✨",
  "💌",
  "🫣",
  "🔥",
  "👀",
];

function randomThreshold(): number {
  return THRESHOLD_MIN + Math.floor(Math.random() * (THRESHOLD_MAX - THRESHOLD_MIN + 1));
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Pending non-AMA sugar messages waiting for digest. */
export async function countPendingTumba(admin: SupabaseClient, chatId: string): Promise<number> {
  const { count } = await admin
    .from("tumba_messages")
    .select("id", { count: "exact", head: true })
    .eq("chat_id", chatId)
    .eq("status", "approved")
    .neq("category", "ama");
  return count ?? 0;
}

async function getOrInitThreshold(admin: SupabaseClient, chatId: string): Promise<number> {
  const { data: s } = await admin
    .from("bot_settings")
    .select("id, tumba_digest_threshold")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (s?.tumba_digest_threshold && s.tumba_digest_threshold >= THRESHOLD_MIN) {
    return s.tumba_digest_threshold;
  }
  const t = randomThreshold();
  if (s?.id) {
    await admin.from("bot_settings").update({ tumba_digest_threshold: t }).eq("id", s.id);
  }
  return t;
}

async function resetThreshold(admin: SupabaseClient, chatId: string) {
  const t = randomThreshold();
  await admin.from("bot_settings").update({ tumba_digest_threshold: t }).eq("chat_id", chatId);
}

export async function sendTumbaGroupReminder(
  telegramChatId: number,
  chatUuid: string,
  fromName?: string,
) {
  const link = await buildDeepLink(`tumba_${chatUuid}`);
  const prefix = fromName ? `${fromName}, ` : "";
  await telegram.sendMessage(
    telegramChatId,
    `${prefix}сахарок пишем не тут, а в личке у меня 🤫`,
    link
      ? {
          reply_markup: inlineKeyboard([
            [{ text: "🍬 Написать сахарок в личке", url: link }],
          ]),
        }
      : undefined,
  );
}

export function looksLikeTumbaIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t === "тумба" || t === "сахарок" || t === "tumba") return true;
  return /\b(тумба|сахарок|tumba)\b/i.test(t) && /\b(напиш|хочу|гоу|го|кину|отправ|кинь|скинь|тумб)\b/i.test(t);
}

export async function beginTumbaDialog(
  admin: SupabaseClient,
  telegramUserId: number,
  chatId: string,
  forcedCategory?: TumbaCategory,
) {
  if (forcedCategory) {
    await admin.from("bot_dialogs").upsert({
      telegram_user_id: telegramUserId,
      kind: "tumba_compose",
      state: {
        chatId,
        category: forcedCategory,
        step: forcedCategory === "ama" ? "body" : "target",
      },
    });
    if (forcedCategory === "ama") {
      await telegram.sendMessage(telegramUserId, "🎤 Напиши свой анонимный вопрос для EB:");
    } else {
      await telegram.sendMessage(
        telegramUserId,
        "Кому адресуем? Напиши @username или «всем», если это общее.",
      );
    }
    return;
  }
  await admin.from("bot_dialogs").upsert({
    telegram_user_id: telegramUserId,
    kind: "tumba_compose",
    state: { chatId, step: "category" },
  });
  await telegram.sendMessage(telegramUserId, "🍬 <b>Тумба</b>\nВыбери категорию сахарка:", {
    reply_markup: inlineKeyboard([
      [{ text: CATEGORY_LABELS.confession, callback_data: "tumba_cat:confession" }],
      [{ text: CATEGORY_LABELS.compliment, callback_data: "tumba_cat:compliment" }],
      [{ text: CATEGORY_LABELS.question, callback_data: "tumba_cat:question" }],
      [{ text: CATEGORY_LABELS.ship, callback_data: "tumba_cat:ship" }],
    ]),
  });
}

export async function handleTumbaCategoryChoice(
  admin: SupabaseClient,
  telegramUserId: number,
  category: TumbaCategory,
) {
  const { data: dialog } = await admin
    .from("bot_dialogs")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (!dialog || dialog.kind !== "tumba_compose") return;
  await admin
    .from("bot_dialogs")
    .update({ state: { ...dialog.state, category, step: "target" } })
    .eq("telegram_user_id", telegramUserId);
  await telegram.sendMessage(
    telegramUserId,
    "Кому адресуем? Напиши @username или «всем», если это общее.",
  );
}

function fallbackDigestFormat(
  items: Array<{ n: number; category: string; target: string; body: string }>,
): string {
  const intro = `${DIGEST_HEADERS[Math.floor(Math.random() * DIGEST_HEADERS.length)]} <b>Свежий выпуск Тумбы</b> — анонимки локалки, перемешаны редакцией:`;
  const blocks = items.map(
    (it) =>
      `${it.n}. ${it.category} ${it.target !== "всем" ? `→ ${it.target}` : ""}\n<i>${it.body}</i>`,
  );
  return [intro, "", ...blocks].join("\n\n");
}

async function formatTumbaDigest(
  messages: Array<{
    category: string;
    to_username: string | null;
    body: string;
  }>,
): Promise<string> {
  const shuffled = shuffle(messages);
  const items = shuffled.map((m, i) => ({
    n: i + 1,
    category: CATEGORY_LABELS[m.category as TumbaCategory] ?? m.category,
    target: m.to_username ? `@${m.to_username}` : "всем",
    body: m.body,
  }));

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return fallbackDigestFormat(items);

  try {
    const provider = createDeepSeekProvider(key);
    const { text } = await generateText({
      model: provider(getDeepSeekModel()),
      system: `Ты Beshemyek Bratan. Оформи выпуск «журнала сплетен» локалки — дайджест анонимных сахарков Тумбы.
Правила:
- СВЕЖЕЕ креативное вступление каждый раз (как новый выпуск журнала сплетен локалки) — НИКОГДА не копируй шаблонные фразы
- Нумерованный список сахарков с прикольными мини-заголовками и эмодзи-разделителями
- Тексты сахарков (поле body) сохраняй ДОСЛОВНО — не переписывай
- К ОДНОМУ сахарку добавь короткий шуточный «редакционный комментарий» от бота
- HTML: <b>, <i>. Без markdown. Компактно, живо`,
      prompt: `Сахарки (уже перемешаны, нумеруй 1..N как в данных):\n${JSON.stringify(items, null, 2)}`,
    });
    const out = text?.trim();
    if (out && out.length > 80) return out;
  } catch (e) {
    console.error("formatTumbaDigest AI failed", e);
  }
  return fallbackDigestFormat(items);
}

/** Publish accumulated non-AMA sugar messages as one digest. */
export async function postTumbaDigest(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  category: TumbaCategory | "all" = "all",
) {
  let q = admin.from("tumba_messages").select("*").eq("chat_id", chatId).eq("status", "approved");
  if (category !== "all") q = q.eq("category", category);
  else q = q.neq("category", "ama");
  const { data: messages } = await q;
  if (!messages || messages.length === 0) return 0;

  const body = await formatTumbaDigest(messages);
  const res: any = await telegram.sendMessage(telegramChatId, body);
  const msgId = res?.result?.message_id;
  const replyBtn =
    category === "ama"
      ? inlineKeyboard([
          [
            { text: "💬 Ответить", callback_data: `ama_reply:${chatId}` },
            { text: "⏭ Пропустить", callback_data: `ama_skip:${chatId}` },
          ],
        ])
      : inlineKeyboard([[{ text: "✉️ Ответить анонимно", callback_data: `tumba_reply:${chatId}` }]]);
  if (msgId) {
    await telegram.editMessageReplyMarkup(telegramChatId, msgId, replyBtn);
  }
  await admin
    .from("tumba_messages")
    .update({
      status: "posted",
      posted_at: new Date().toISOString(),
      telegram_message_id: res?.result?.message_id ?? null,
    })
    .in(
      "id",
      messages.map((m) => m.id),
    );
  return messages.length;
}

/** After a new sugar is saved — publish digest if threshold reached. */
export async function maybePublishTumbaDigest(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
) {
  if (!(await isFeatureEnabled(admin, chatId, "tumba"))) return;
  const count = await countPendingTumba(admin, chatId);
  if (count === 0) return;
  const threshold = await getOrInitThreshold(admin, chatId);
  if (count < threshold) return;
  await postTumbaDigest(admin, chatId, telegramChatId, "all");
  await resetThreshold(admin, chatId);
}

/** Cron backup: check every chat for threshold. */
export async function runTumbaAccumulationTick(admin: SupabaseClient) {
  const { data: chats } = await admin
    .from("chats")
    .select("id, telegram_chat_id")
    .eq("is_active", true);
  for (const chat of chats ?? []) {
    try {
      if (!(await isFeatureEnabled(admin, chat.id, "tumba"))) continue;
      await maybePublishTumbaDigest(admin, chat.id, chat.telegram_chat_id);
    } catch (e) {
      console.error(`tumba accumulation tick failed for ${chat.telegram_chat_id}`, e);
    }
  }
}

/** Returns true if the message was consumed by the dialog. */
export async function handleTumbaDialogMessage(
  admin: SupabaseClient,
  dialog: { telegram_user_id: number; state: any },
  text: string,
): Promise<boolean> {
  const state = dialog.state;
  if (state.step === "target") {
    const toUsername = text.trim().toLowerCase() === "всем" ? null : text.trim().replace(/^@/, "");
    await admin
      .from("bot_dialogs")
      .update({ state: { ...state, toUsername, step: "body" } })
      .eq("telegram_user_id", dialog.telegram_user_id);
    await telegram.sendMessage(dialog.telegram_user_id, "Теперь напиши текст сахарка:");
    return true;
  }
  if (state.step === "body") {
    const moderation = await moderateText(text);
    if (!moderation.approved) {
      await admin.from("bot_dialogs").delete().eq("telegram_user_id", dialog.telegram_user_id);
      await telegram.sendMessage(
        dialog.telegram_user_id,
        "Эм, братишка, это не пройдёт модерацию (хейт/личные данные). Попробуй переформулировать и отправь заново.",
      );
      return true;
    }
    await admin.from("tumba_messages").insert({
      chat_id: state.chatId,
      from_telegram_user_id: dialog.telegram_user_id,
      to_username: state.toUsername ?? null,
      category: state.category,
      body: text.trim(),
      status: "approved",
    });
    await admin.from("bot_dialogs").delete().eq("telegram_user_id", dialog.telegram_user_id);

    const { data: chatRow } = await admin
      .from("chats")
      .select("telegram_chat_id")
      .eq("id", state.chatId)
      .maybeSingle();

    if (state.category === "ama") {
      await telegram.sendMessage(
        dialog.telegram_user_id,
        "Принято! Вопрос уйдёт в следующий батч AMA. 🎤",
      );
    } else {
      const pending = await countPendingTumba(admin, state.chatId);
      const threshold = await getOrInitThreshold(admin, state.chatId);
      await telegram.sendMessage(
        dialog.telegram_user_id,
        `Принято! 🍬 Сахарок в очереди (${pending}/${threshold}). Когда наберётся — выложу дайджестом в чат.`,
      );
      if (chatRow?.telegram_chat_id) {
        await maybePublishTumbaDigest(admin, state.chatId, chatRow.telegram_chat_id);
      }
    }
    return true;
  }
  return false;
}
