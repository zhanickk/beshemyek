import { telegram, inlineKeyboard } from "@/lib/telegram.server";
import { awardCoins, getBalance } from "@/lib/economy.server";
import {
  createSession,
  getActiveSession,
  finishSession,
  packCallback,
  type GameCtx,
  type GameSession,
} from "./engine.server";

const OPEN_MS = 90 * 1000;

interface RedButtonState {
  pressed: boolean;
  reward: number;
  penalty: number;
  messageId?: number;
  deadlineAt: string;
  [key: string]: unknown;
}

function randInt(min: number, max: number) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

const DRAMA_LINES = [
  "⚠️ Внимание. Обнаружен нестабильный чемоданчик неизвестного происхождения.",
  "📡 Сигнал усиливается. Внутри что-то щёлкает. Это либо джекпот, либо подстава.",
  "☢️ Последнее предупреждение: один клик — и судьба решится. Фифти-фифти.",
];

export async function startRedButton(ctx: GameCtx, invoker: { id: number; name: string }) {
  const existing = await getActiveSession(ctx.admin, ctx.chatId);
  if (existing) return { alreadyActive: true as const };

  const reward = randInt(20, 60);
  const penalty = randInt(10, 40);
  const state: RedButtonState = {
    pressed: false,
    reward,
    penalty,
    deadlineAt: new Date(Date.now() + OPEN_MS).toISOString(),
  };
  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "red_button",
    state,
    invoker.id,
    "active",
  );

  for (const line of DRAMA_LINES) {
    await telegram.sendChatAction(ctx.telegramChatId, "typing");
    await telegram.sendMessage(ctx.telegramChatId, line);
  }

  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    "💣 <b>КРАСНАЯ КНОПКА АКТИВИРОВАНА</b>\nКто нажмёт первым — узнает, повезло или нет.",
    {
      reply_markup: inlineKeyboard([
        [{ text: "💣 НАЖАТЬ", callback_data: packCallback(session.short_code, "press") }],
      ]),
    },
  );
  const messageId = sent?.result?.message_id;
  if (messageId) {
    await ctx.admin
      .from("game_sessions")
      .update({ state: { ...state, messageId } })
      .eq("id", session.id);
  }
  return { session };
}

export async function handleRedButtonCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  _payload: string,
  callbackQueryId: string,
  presser: { id: number; name: string },
) {
  if (action !== "press") return;
  const state = session.state as RedButtonState;
  if (state.pressed) {
    await telegram.answerCallbackQuery(callbackQueryId, "Поздняк — кто-то уже нажал!", true);
    return;
  }

  await finishSession(ctx.admin, session.id, { ...state, pressed: true, pressedBy: presser.id });
  await telegram.answerCallbackQuery(callbackQueryId, "Ты рискнул(а)! 🎲");
  if (state.messageId) {
    await telegram.editMessageReplyMarkup(ctx.telegramChatId, state.messageId, undefined);
  }

  const won = Math.random() < 0.5;
  if (won) {
    await awardCoins(ctx.admin, ctx.chatId, presser.id, state.reward, "game_win", {
      game: "red_button",
    });
    await telegram.sendMessage(
      ctx.telegramChatId,
      `🎉 ${presser.name} вскрыл(а) чемоданчик — там джекпот! +${state.reward} БешКоинов. Фарт на твоей стороне.`,
    );
  } else {
    const balance = await getBalance(ctx.admin, ctx.chatId, presser.id);
    const lost = Math.min(balance, state.penalty);
    if (lost > 0) {
      await awardCoins(ctx.admin, ctx.chatId, presser.id, -lost, "game_loss", {
        game: "red_button",
      });
    }
    await telegram.sendMessage(
      ctx.telegramChatId,
      lost > 0
        ? `💥 Бабах! ${presser.name}, это была подстава — минус ${lost} БешКоинов. Кто не рискует, тот не теряет.`
        : `💥 Бабах! ${presser.name}, это была подстава — но терять у тебя было нечего, повезло по-своему.`,
    );
  }
}

export async function tickRedButton(ctx: GameCtx, session: GameSession) {
  const state = session.state as RedButtonState;
  if (state.pressed) return;
  if (!state.deadlineAt || Date.now() < new Date(state.deadlineAt).getTime()) return;
  await finishSession(ctx.admin, session.id, { ...state, expired: true });
  if (state.messageId) {
    await telegram.editMessageReplyMarkup(ctx.telegramChatId, state.messageId, undefined);
  }
  await telegram.sendMessage(
    ctx.telegramChatId,
    "🐔 Никто не рискнул нажать. Чемоданчик самоуничтожился, храбрецов не нашлось.",
  );
}
