import { telegram, inlineKeyboard, buildDeepLink } from "@/lib/telegram.server";
import { awardCoins } from "@/lib/economy.server";
import {
  createSession,
  getActiveSession,
  finishSession,
  updateSessionState,
  packCallback,
  type GameCtx,
  type GameSession,
} from "./engine.server";
import { randomCrocodileWord, containsWord } from "./words";

const ROUND_MS = 3 * 60 * 1000;

export async function startCrocodile(ctx: GameCtx, invoker: { id: number; name: string }) {
  const existing = await getActiveSession(ctx.admin, ctx.chatId);
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
    await telegram.sendMessage(
      invoker.id,
      `🐊 Твоё слово для Крокодила: <b>${word}</b>\nОбъясни его чату, не называя впрямую и без однокоренных слов!`,
    );
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
  await telegram.sendMessage(
    telegramUserId,
    `🐊 Твоё слово для Крокодила: <b>${session.state.word}</b>\nОбъясни его чату, не называя впрямую!`,
  );
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
