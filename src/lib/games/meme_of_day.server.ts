import { telegram, inlineKeyboard } from "@/lib/telegram.server";
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

const ROUND_MS = 6 * 3600 * 1000;

type MemeEntry = { messageId: number; userId: number; userName: string; votes: number };

export async function startMemeOfDay(ctx: GameCtx) {
  const existing = await getActiveSession(ctx.admin, ctx.chatId);
  if (existing) return { alreadyActive: true as const };
  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "meme_of_day",
    {
      entries: [] as MemeEntry[],
      voterChoice: {} as Record<string, number>,
      deadlineAt: new Date(Date.now() + ROUND_MS).toISOString(),
    },
    null,
    "active",
  );
  await telegram.sendMessage(
    ctx.telegramChatId,
    `😂 <b>Мем дня начался!</b> Кидайте мемы в этот тред следующие ${ROUND_MS / 3600000}ч, голосуем 🔥 под лучшим.`,
  );
  return { session };
}

export async function handleMemeMessage(
  ctx: GameCtx,
  session: GameSession,
  message: { message_id: number; from?: { id: number }; photo?: unknown; animation?: unknown },
  fromName: string,
): Promise<boolean> {
  if (!message.photo && !message.animation) return false;
  const entries: MemeEntry[] = session.state.entries ?? [];
  const entry: MemeEntry = {
    messageId: message.message_id,
    userId: message.from!.id,
    userName: fromName,
    votes: 0,
  };
  await updateSessionState(ctx.admin, session.id, {
    ...session.state,
    entries: [...entries, entry],
  });
  await telegram.sendMessage(ctx.telegramChatId, "🔥 0", {
    reply_to_message_id: message.message_id,
    reply_markup: inlineKeyboard([
      [
        {
          text: "🔥 0",
          callback_data: packCallback(session.short_code, "vote", String(message.message_id)),
        },
      ],
    ]),
  });
  return true;
}

export async function handleMemeCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  payload: string,
  callbackQueryId: string,
  voterId: number,
) {
  if (action !== "vote") return;
  const messageId = Number(payload);
  const voterChoice: Record<string, number> = { ...(session.state.voterChoice ?? {}) };
  if (voterChoice[String(voterId)] === messageId) {
    await telegram.answerCallbackQuery(callbackQueryId, "Ты уже голосовал(а) за этот мем!");
    return;
  }
  voterChoice[String(voterId)] = messageId;
  const entries: MemeEntry[] = (session.state.entries ?? []).map((e: MemeEntry) =>
    e.messageId === messageId ? { ...e, votes: e.votes + 1 } : e,
  );
  await updateSessionState(ctx.admin, session.id, { ...session.state, entries, voterChoice });
  await telegram.answerCallbackQuery(callbackQueryId, "Голос принят! 🔥");
  const entry = entries.find((e) => e.messageId === messageId);
  if (entry) {
    await telegram.editMessageReplyMarkup(
      ctx.telegramChatId,
      messageId,
      inlineKeyboard([
        [
          {
            text: `🔥 ${entry.votes}`,
            callback_data: packCallback(session.short_code, "vote", String(messageId)),
          },
        ],
      ]) as any,
    );
  }
}

export async function tickMemeOfDay(ctx: GameCtx, session: GameSession) {
  if (new Date(session.state.deadlineAt).getTime() > Date.now()) return;
  const entries: MemeEntry[] = session.state.entries ?? [];
  await finishSession(ctx.admin, session.id, session.state);
  if (entries.length === 0) {
    await telegram.sendMessage(
      ctx.telegramChatId,
      "Мем дня закончился, но никто ничего не кинул 😔",
    );
    return;
  }
  const maxVotes = Math.max(...entries.map((e) => e.votes));
  const winners = entries.filter((e) => e.votes === maxVotes);
  for (const w of winners) {
    await awardCoins(ctx.admin, ctx.chatId, w.userId, 30, "game_win", { game: "meme_of_day" });
  }
  await telegram.sendMessage(
    ctx.telegramChatId,
    `🏆 <b>Мем дня:</b> ${winners.map((w) => w.userName).join(", ")} с ${maxVotes} 🔥! +30 БешКоинов.`,
  );
}
