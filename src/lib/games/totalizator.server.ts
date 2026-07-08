import { telegram, inlineKeyboard } from "@/lib/telegram.server";
import { awardCoins, spendCoins } from "@/lib/economy.server";
import { truncateBtn } from "@/lib/keyboards.server";
import {
  createSession,
  getBlockingSession,
  finishSession,
  updateSessionState,
  packCallback,
  type GameCtx,
  type GameSession,
} from "./engine.server";

const STAKE = 10;

function betKeyboard(session: GameSession) {
  const options: string[] = session.state.options ?? [];
  const bets: Record<string, number> = session.state.bets ?? {};
  const counts = options.map((_, i) =>
    Object.values(bets).filter((v) => Number(v) === i).length,
  );
  const rows = options.map((opt, i) => [
    {
      text: `${truncateBtn(opt)} (${counts[i]})`,
      callback_data: packCallback(session.short_code, "pick", String(i)),
    },
  ]);
  rows.push([
    {
      text: "Закрыть ставки",
      callback_data: packCallback(session.short_code, "close"),
    },
  ]);
  return inlineKeyboard(rows);
}

export async function startTotalizator(
  ctx: GameCtx,
  question: string,
  options: string[],
  creatorId?: number,
) {
  const existing = await getBlockingSession(ctx.admin, ctx.chatId, "totalizator");
  if (existing) return { alreadyActive: true as const };

  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "totalizator",
    { question, options, bets: {}, creatorId: creatorId ?? null },
    creatorId ?? null,
    "active",
  );
  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    `🎰 <b>Тотализатор:</b> ${question}\nСтавка: ${STAKE} БешКоинов. Выбери вариант:`,
    { reply_markup: betKeyboard(session) },
  );
  const messageId = sent?.result?.message_id;
  if (messageId) {
    await updateSessionState(ctx.admin, session.id, { ...session.state, messageId });
  }
  return { session };
}

async function refreshBetMessage(ctx: GameCtx, session: GameSession) {
  const msgId = session.state.messageId;
  if (!msgId) return;
  const bets = (session.state.bets ?? {}) as Record<string, number>;
  const counts = (session.state.options as string[]).map((_, i) =>
    Object.values(bets).filter((v) => v === i).length,
  );
  const total = Object.keys(session.state.bets ?? {}).length;
  await telegram.editMessageText(
    ctx.telegramChatId,
    msgId,
    `🎰 <b>Тотализатор:</b> ${session.state.question}\nСтавка: ${STAKE} 🪙 • Голосов: ${total}`,
    { reply_markup: betKeyboard(session) },
  );
}

export async function handleTotalizatorCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  payload: string,
  callbackQueryId: string,
  voterId: number,
) {
  if (action === "close") {
    const creatorId = session.state.creatorId ?? session.created_by;
    if (voterId !== creatorId) {
      await telegram.answerCallbackQuery(callbackQueryId, "Закрыть может только создатель.", true);
      return;
    }
    const bets: Record<string, number> = session.state.bets ?? {};
    if (Object.keys(bets).length === 0) {
      await telegram.answerCallbackQuery(callbackQueryId, "Пока никто не поставил.", true);
      return;
    }
    await telegram.answerCallbackQuery(callbackQueryId, "Ставки закрыты!");
    await finishSession(ctx.admin, session.id, { ...session.state, closed: true });
    if (session.state.messageId) {
      await telegram.editMessageReplyMarkup(ctx.telegramChatId, session.state.messageId, undefined);
    }
    const tally = (session.state.options as string[])
      .map((opt: string, i: number) => {
        const n = Object.values(bets).filter((v) => v === i).length;
        return `${opt}: ${n}`;
      })
      .join("\n");
    await telegram.sendMessage(
      ctx.telegramChatId,
      `🔒 Ставки закрыты!\n\n${tally}\n\nСоздатель: укажи победивший вариант — <code>/bet_resolve 0</code> (номер с 0).`,
    );
    return;
  }

  if (action !== "pick") return;
  const bets: Record<string, number> = session.state.bets ?? {};
  if (bets[String(voterId)] !== undefined) {
    await telegram.answerCallbackQuery(callbackQueryId, "Ты уже сделал(а) ставку!", true);
    return;
  }
  const ok = await spendCoins(ctx.admin, ctx.chatId, voterId, STAKE, { game: "totalizator" });
  if (!ok) {
    await telegram.answerCallbackQuery(
      callbackQueryId,
      `Недостаточно БешКоинов (нужно ${STAKE}).`,
      true,
    );
    return;
  }
  const updatedBets = { ...bets, [String(voterId)]: Number(payload) };
  const nextState = { ...session.state, bets: updatedBets };
  await updateSessionState(ctx.admin, session.id, nextState);
  await telegram.answerCallbackQuery(
    callbackQueryId,
    `Ставка на «${session.state.options[Number(payload)]}»!`,
  );
  await refreshBetMessage(ctx, { ...session, state: nextState });
}

export async function resolveTotalizator(ctx: GameCtx, winningOption: number) {
  const session = await getActiveSession(ctx.admin, ctx.chatId, "totalizator");
  if (!session) return { noActive: true as const };

  const bets: Record<string, number> = session.state.bets ?? {};
  const winners = Object.entries(bets)
    .filter(([, opt]) => opt === winningOption)
    .map(([id]) => Number(id));
  const pool = Object.keys(bets).length * STAKE;

  if (winners.length === 0) {
    for (const id of Object.keys(bets))
      await awardCoins(ctx.admin, ctx.chatId, Number(id), STAKE, "admin_adjust", {
        game: "totalizator_refund",
      });
    await telegram.sendMessage(
      ctx.telegramChatId,
      "Победителей не оказалось, ставки возвращены всем участникам.",
    );
  } else {
    const share = Math.floor(pool / winners.length);
    for (const id of winners)
      await awardCoins(ctx.admin, ctx.chatId, id, share, "game_win", { game: "totalizator" });
    await telegram.sendMessage(
      ctx.telegramChatId,
      `🎰 Победил вариант «${session.state.options[winningOption]}»! Победители (${winners.length}) получили по +${share} БешКоинов.`,
    );
  }
  await finishSession(ctx.admin, session.id, { ...session.state, winningOption });
  return { ok: true as const };
}
