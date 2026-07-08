import { telegram, inlineKeyboard } from "@/lib/telegram.server";
import { awardCoins, pickRandomMembers } from "@/lib/economy.server";
import {
  createSession,
  getActiveSession,
  finishSession,
  packCallback,
  type GameCtx,
  type GameSession,
} from "./engine.server";
import { TRUTH_OR_DARE } from "./words";

export async function startTruthOrDare(ctx: GameCtx, invoker: { id: number; name: string }) {
  const existing = await getActiveSession(ctx.admin, ctx.chatId);
  if (existing) return { alreadyActive: true as const };

  const pool = await pickRandomMembers(ctx.admin, ctx.chatId, 1);
  const target = pool[0]
    ? {
        id: pool[0].telegram_user_id,
        name: pool[0].display_name || pool[0].username || invoker.name,
      }
    : invoker;

  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "truth_or_dare",
    { targetId: target.id, targetName: target.name },
    invoker.id,
    "active",
  );
  await telegram.sendMessage(
    ctx.telegramChatId,
    `🎯 <b>Правда или действие — AIESEC edition</b>\n${target.name}, выбирай:`,
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
) {
  if (fromUserId !== session.state.targetId) {
    await telegram.answerCallbackQuery(callbackQueryId, "Это не твой ход 😏", true);
    return;
  }

  if (action === "truth" || action === "dare") {
    await ctx.admin
      .from("game_sessions")
      .update({ state: { ...session.state, choice: action } })
      .eq("id", session.id);
    await telegram.answerCallbackQuery(
      callbackQueryId,
      action === "truth" ? "Правда!" : "Действие!",
    );
    await telegram.sendMessage(ctx.telegramChatId, "Выбери уровень фанта:", {
      reply_markup: inlineKeyboard([
        [
          { text: "🙂 Лайт", callback_data: packCallback(session.short_code, "light") },
          { text: "🔥 Жёстче", callback_data: packCallback(session.short_code, "hard") },
        ],
      ]),
    });
    return;
  }

  if (action === "light" || action === "hard") {
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
