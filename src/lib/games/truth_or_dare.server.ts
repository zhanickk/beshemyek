import { telegram, inlineKeyboard } from "@/lib/telegram.server";
import { awardCoins } from "@/lib/economy.server";
import {
  createSession,
  getBlockingSession,
  finishSession,
  packCallback,
  updateSessionState,
  type GameCtx,
  type GameSession,
} from "./engine.server";
import { TRUTH_OR_DARE } from "./words";

export async function startTruthOrDare(ctx: GameCtx, invoker: { id: number; name: string }) {
  const existing = await getBlockingSession(ctx.admin, ctx.chatId, "truth_or_dare");
  if (existing) return { alreadyActive: true as const };

  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "truth_or_dare",
    { targetId: null, targetName: null, invokerId: invoker.id },
    invoker.id,
    "active",
  );
  await telegram.sendMessage(
    ctx.telegramChatId,
    `🎯 <b>Правда или действие — AIESEC edition</b>\nКто жмёт кнопку — тот играет:`,
    {
      reply_markup: inlineKeyboard([
        [
          { text: "🗣 Правда", callback_data: packCallback(session.short_code, "truth") },
          { text: "🎯 Действие", callback_data: packCallback(session.short_code, "dare") },
        ],
      ]),
    },
  );
  return { session };
}

export async function handleTruthOrDareCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  _payload: string,
  callbackQueryId: string,
  fromUserId: number,
  fromName: string,
) {
  const targetId: number | null = session.state.targetId ?? null;

  if (action === "truth" || action === "dare") {
    if (targetId !== null && fromUserId !== targetId) {
      await telegram.answerCallbackQuery(callbackQueryId, "Это не твой ход 😏", true);
      return;
    }

    const nextState = {
      ...session.state,
      targetId: fromUserId,
      targetName: fromName,
      choice: action,
    };
    await updateSessionState(ctx.admin, session.id, nextState);
    await telegram.answerCallbackQuery(
      callbackQueryId,
      action === "truth" ? "Правда!" : "Действие!",
    );
    await telegram.sendMessage(
      ctx.telegramChatId,
      `${fromName}, выбирай уровень фанта:`,
      {
        reply_markup: inlineKeyboard([
          [
            { text: "🙂 Лайт", callback_data: packCallback(session.short_code, "light") },
            { text: "🔥 Жёстче", callback_data: packCallback(session.short_code, "hard") },
          ],
        ]),
      },
    );
    return;
  }

  if (action === "light" || action === "hard") {
    if (targetId === null || fromUserId !== targetId) {
      await telegram.answerCallbackQuery(callbackQueryId, "Это не твой ход 😏", true);
      return;
    }

    const choice: "truth" | "dare" = session.state.choice;
    const bank = TRUTH_OR_DARE[choice][action];
    const prompt = bank[Math.floor(Math.random() * bank.length)];
    await telegram.answerCallbackQuery(callbackQueryId, "Держи фант!");
    await awardCoins(ctx.admin, ctx.chatId, fromUserId, 10, "game_win", { game: "truth_or_dare" });
    await finishSession(ctx.admin, session.id, { ...session.state, difficulty: action, prompt });
    await telegram.sendMessage(
      ctx.telegramChatId,
      `${session.state.targetName}, вот твой фант:\n\n<i>${prompt}</i>\n\n+10 БешКоинов за участие!`,
    );
  }
}
