import { telegram, inlineKeyboard, buildDeepLink } from "@/lib/telegram.server";
import { awardCoins } from "@/lib/economy.server";
import {
  createSession,
  getBlockingSession,
  finishSession,
  updateSessionState,
  packCallback,
  type GameCtx,
  type GameSession,
} from "./engine.server";
import { randomCrocodileWord, containsWord } from "./crocodile-words";

const ROUND_MS = 3 * 60 * 1000;

function explainerDmKeyboard(shortCode: string) {
  return inlineKeyboard([
    [{ text: "🔄 Другое слово", callback_data: packCallback(shortCode, "skip") }],
  ]);
}

async function sendExplainerWord(telegramUserId: number, session: GameSession) {
  await telegram.sendMessage(
    telegramUserId,
    `🐊 Твоё слово для Крокодила: <b>${session.state.word}</b>\nКатегория: «${session.state.category}»\nОбъясни его чату, не называя впрямую и без однокоренных слов!\n\nНе знаешь слово? Жми «Другое слово» или напиши /skip`,
    { reply_markup: explainerDmKeyboard(session.short_code) },
  );
}

async function skipCrocodileWord(
  ctx: GameCtx,
  session: GameSession,
  fromUserId: number,
  callbackQueryId?: string,
) {
  if (fromUserId !== session.state.explainerId) {
    if (callbackQueryId) {
      await telegram.answerCallbackQuery(callbackQueryId, "Скип может только загадывающий", true);
    }
    return;
  }
  const skippedWords = [...(session.state.skippedWords ?? []), session.state.word];
  const { word, category } = randomCrocodileWord(skippedWords);
  const nextState = { ...session.state, word, category, skippedWords };
  await updateSessionState(ctx.admin, session.id, nextState);
  session.state = nextState;
  if (callbackQueryId) {
    await telegram.answerCallbackQuery(callbackQueryId, "Вот другое слово 👇");
  }
  await sendExplainerWord(fromUserId, session);
}

export async function startCrocodile(ctx: GameCtx, invoker: { id: number; name: string }) {
  const existing = await getBlockingSession(ctx.admin, ctx.chatId, "crocodile");
  if (existing) return { alreadyActive: true as const };

  const { word, category } = randomCrocodileWord();
  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "crocodile",
    {
      explainerId: invoker.id,
      explainerName: invoker.name,
      word,
      category,
      deadlineAt: new Date(Date.now() + ROUND_MS).toISOString(),
    },
    invoker.id,
    "active",
  );

  let dmSent = false;
  try {
    await sendExplainerWord(invoker.id, session);
    dmSent = true;
  } catch (e) {
    console.error("crocodile DM failed", e);
  }

  if (!dmSent) {
    const link = await buildDeepLink(`croc_${session.short_code}`);
    await telegram.sendMessage(
      ctx.telegramChatId,
      `${invoker.name}, не смог написать тебе в личку 😅 ${link ? `Жми сюда и потом /start: ${link}` : "Напиши мне первым в личку /start."}`,
    );
  }

  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    `🐊 <b>Крокодил начался!</b>\n${invoker.name} загадывает слово. У чата ${ROUND_MS / 60000} минуты, чтобы угадать прямо в этом треде!`,
    {
      reply_markup: inlineKeyboard([
        [
          { text: "💡 Подсказка", callback_data: packCallback(session.short_code, "hint") },
          { text: "🏳 Сдаться", callback_data: packCallback(session.short_code, "surrender") },
        ],
      ]),
    },
  );
  const gameMessageId = sent?.result?.message_id;
  if (gameMessageId) {
    await updateSessionState(ctx.admin, session.id, { ...session.state, gameMessageId });
  }
  return { session };
}

export async function resendCrocodileWord(
  admin: GameCtx["admin"],
  session: GameSession,
  telegramUserId: number,
) {
  if (session.state.explainerId !== telegramUserId) return;
  await sendExplainerWord(telegramUserId, session);
}

export async function handleCrocodilePrivateMessage(
  admin: GameCtx["admin"],
  telegramUserId: number,
  text: string,
): Promise<boolean> {
  const cmd = text.trim().toLowerCase();
  if (cmd !== "/skip") return false;

  const { data: sessions } = await admin
    .from("game_sessions")
    .select("*, chats!inner(telegram_chat_id)")
    .eq("type", "crocodile")
    .eq("status", "active");

  for (const raw of sessions ?? []) {
    if (raw.state.explainerId !== telegramUserId) continue;
    const ctx: GameCtx = {
      admin,
      chatId: raw.chat_id,
      telegramChatId: (raw as any).chats.telegram_chat_id,
      lang: "ru",
    };
    await skipCrocodileWord(ctx, raw as GameSession, telegramUserId);
    return true;
  }

  await telegram.sendMessage(telegramUserId, "Сейчас ты нигде не загадываешь в Крокодиле 🐊");
  return true;
}

export async function handleCrocodileCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  callbackQueryId: string,
  fromUserId: number,
) {
  if (action === "hint") {
    if (fromUserId !== session.state.explainerId) {
      await telegram.answerCallbackQuery(callbackQueryId, "Подсказку даёт только загадывающий 😏", true);
      return;
    }
    await telegram.answerCallbackQuery(callbackQueryId, `Категория: ${session.state.category}`);
    await telegram.sendMessage(
      ctx.telegramChatId,
      `💡 Подсказка: слово из категории «<b>${session.state.category}</b>»`,
    );
    return;
  }
  if (action === "skip") {
    await skipCrocodileWord(ctx, session, fromUserId, callbackQueryId);
    return;
  }
  if (action === "surrender") {
    if (fromUserId !== session.state.explainerId) {
      await telegram.answerCallbackQuery(callbackQueryId, "Сдаться может только загадывающий", true);
      return;
    }
    await finishSession(ctx.admin, session.id, { ...session.state, surrendered: true });
    if (session.state.gameMessageId) {
      await telegram.editMessageReplyMarkup(ctx.telegramChatId, session.state.gameMessageId, undefined);
    }
    await telegram.answerCallbackQuery(callbackQueryId, "Сдался!");
    await telegram.sendMessage(
      ctx.telegramChatId,
      `🏳 ${session.state.explainerName} сдался! Слово было «<b>${session.state.word}</b>».`,
    );
  }
}

export async function handleCrocodileMessage(
  ctx: GameCtx,
  session: GameSession,
  message: { from?: { id: number }; text?: string },
): Promise<boolean> {
  if (!message.text || message.from?.id === session.state.explainerId) return false;
  if (!containsWord(message.text, session.state.word)) return false;

  const guesserId = message.from!.id;
  await awardCoins(ctx.admin, ctx.chatId, guesserId, 15, "game_win", { game: "crocodile" });
  await awardCoins(ctx.admin, ctx.chatId, session.state.explainerId, 5, "game_win", {
    game: "crocodile_explainer",
  });
  await finishSession(ctx.admin, session.id, { ...session.state, winnerId: guesserId });
  if (session.state.gameMessageId) {
    await telegram.editMessageReplyMarkup(ctx.telegramChatId, session.state.gameMessageId, undefined);
  }
  await telegram.sendMessage(
    ctx.telegramChatId,
    `🎉 Угадано! Слово было «<b>${session.state.word}</b>». +15 БешКоинов угадавшему, +5 объяснявшему.`,
  );
  return true;
}

export async function tickCrocodile(ctx: GameCtx, session: GameSession) {
  if (new Date(session.state.deadlineAt).getTime() > Date.now()) return;
  await finishSession(ctx.admin, session.id, session.state);
  if (session.state.gameMessageId) {
    await telegram.editMessageReplyMarkup(ctx.telegramChatId, session.state.gameMessageId, undefined);
  }
  await telegram.sendMessage(
    ctx.telegramChatId,
    `⏰ Время вышло! Слово было «<b>${session.state.word}</b>». Никто не угадал, бывает.`,
  );
}
