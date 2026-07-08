import { generateText } from "ai";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";
import { telegram, inlineKeyboard } from "@/lib/telegram.server";
import { awardCoins, pickRandomMembers } from "@/lib/economy.server";
import {
  createSession,
  getActiveSession,
  finishSession,
  updateSessionState,
  packCallback,
  type GameCtx,
  type GameSession,
} from "./engine.server";

const VOTE_MS = 3 * 60 * 1000;
const WIN_REWARD = 30;
const CONSOLATION = 10;

interface DuelState {
  situation: string;
  duelists: Array<{ id: number; name: string; excuse: string }>;
  votes: Record<string, number>; // voterId -> 0|1
  messageId?: number;
  deadlineAt: string;
  [key: string]: unknown;
}

const FALLBACK = {
  situation: "Тебя поймали на том, что ты пропал(а) на неделю и не отвечал(а) вообще нигде.",
  excuses: [
    "Меня засосало в переписку с техподдержкой, я только сегодня выбрался, честно.",
    "Я ушёл в цифровой детокс, но детокс ушёл в детокс от меня, всё сложно.",
  ],
};

/** Asks the model for a fresh absurd situation + two distinct funny excuses (varied each time). */
async function generateDuelContent(
  nameA: string,
  nameB: string,
): Promise<{ situation: string; excuseA: string; excuseB: string }> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    return {
      situation: FALLBACK.situation,
      excuseA: FALLBACK.excuses[0],
      excuseB: FALLBACK.excuses[1],
    };
  }
  try {
    const provider = createDeepSeekProvider(key);
    const { text } = await generateText({
      model: provider(getDeepSeekModel()),
      system:
        'Ты придумываешь контент для игры «Дуэль отмазок». Верни СТРОГО JSON без markdown: {"situation": string, "excuseA": string, "excuseB": string}. situation — одна короткая абсурдно-житейская ситуация, за которую нужно оправдаться (на русском). excuseA и excuseB — две РАЗНЫЕ смешные абсурдные отмазки на эту ситуацию, каждая 1-2 предложения, свежие и оригинальные, без повторов шаблонов. Только на русском.',
      prompt: `Ситуация и две отмазки для дуэли между ${nameA} и ${nameB}. Верни только JSON.`,
    });
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.situation && parsed.excuseA && parsed.excuseB) {
      return {
        situation: String(parsed.situation),
        excuseA: String(parsed.excuseA),
        excuseB: String(parsed.excuseB),
      };
    }
  } catch (e) {
    console.error("excuse duel generation failed", e);
  }
  return {
    situation: FALLBACK.situation,
    excuseA: FALLBACK.excuses[0],
    excuseB: FALLBACK.excuses[1],
  };
}

export async function startExcuseDuel(ctx: GameCtx) {
  const existing = await getActiveSession(ctx.admin, ctx.chatId);
  if (existing) return { alreadyActive: true as const };

  const members = await pickRandomMembers(ctx.admin, ctx.chatId, 6);
  if (members.length < 2) return { notEnough: true as const };
  const [a, b] = members;
  const nameA = a.display_name || (a.username ? `@${a.username}` : `#${a.telegram_user_id}`);
  const nameB = b.display_name || (b.username ? `@${b.username}` : `#${b.telegram_user_id}`);

  const { situation, excuseA, excuseB } = await generateDuelContent(nameA, nameB);

  const state: DuelState = {
    situation,
    duelists: [
      { id: a.telegram_user_id, name: nameA, excuse: excuseA },
      { id: b.telegram_user_id, name: nameB, excuse: excuseB },
    ],
    votes: {},
    deadlineAt: new Date(Date.now() + VOTE_MS).toISOString(),
  };
  const session = await createSession(ctx.admin, ctx.chatId, "excuse_duel", state, null, "active");

  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    `🥊 <b>Дуэль отмазок!</b>\nСитуация: <i>${situation}</i>\n\n🅰️ <b>${nameA}</b>: ${excuseA}\n\n🅱️ <b>${nameB}</b>: ${excuseB}\n\nЧья отмазка смешнее? Голосуем (${Math.round(VOTE_MS / 60000)} мин):`,
    {
      reply_markup: inlineKeyboard([
        [
          { text: `🅰️ ${nameA}`, callback_data: packCallback(session.short_code, "v", "0") },
          { text: `🅱️ ${nameB}`, callback_data: packCallback(session.short_code, "v", "1") },
        ],
      ]),
    },
  );
  const messageId = sent?.result?.message_id;
  if (messageId) await updateSessionState(ctx.admin, session.id, { ...state, messageId });
  return { session };
}

export async function handleExcuseDuelCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  payload: string,
  callbackQueryId: string,
  voterId: number,
) {
  if (action !== "v") return;
  const state = session.state as DuelState;
  if (state.votes[String(voterId)] !== undefined) {
    await telegram.answerCallbackQuery(callbackQueryId, "Ты уже голосовал(а)!", true);
    return;
  }
  const choice = Number(payload) === 1 ? 1 : 0;
  const votes = { ...state.votes, [String(voterId)]: choice };
  await updateSessionState(ctx.admin, session.id, { ...state, votes });
  await telegram.answerCallbackQuery(
    callbackQueryId,
    `Голос за ${state.duelists[choice]?.name ?? "вариант"} принят!`,
  );
}

export async function tickExcuseDuel(ctx: GameCtx, session: GameSession) {
  const state = session.state as DuelState;
  if (!state.deadlineAt || Date.now() < new Date(state.deadlineAt).getTime()) return;

  const tally = [0, 0];
  for (const choice of Object.values(state.votes)) tally[choice] = (tally[choice] ?? 0) + 1;

  if (state.messageId) {
    await telegram.editMessageReplyMarkup(ctx.telegramChatId, state.messageId, undefined);
  }
  await finishSession(ctx.admin, session.id, { ...state, tally });

  const [a, b] = state.duelists;
  if (tally[0] === 0 && tally[1] === 0) {
    await telegram.sendMessage(
      ctx.telegramChatId,
      "Никто не проголосовал в дуэли отмазок — ничья по трусости, оба остаются при своих.",
    );
    return;
  }
  if (tally[0] === tally[1]) {
    await awardCoins(ctx.admin, ctx.chatId, a.id, CONSOLATION, "game_win", { game: "excuse_duel" });
    await awardCoins(ctx.admin, ctx.chatId, b.id, CONSOLATION, "game_win", { game: "excuse_duel" });
    await telegram.sendMessage(
      ctx.telegramChatId,
      `🤝 Ничья ${tally[0]}:${tally[1]}! ${a.name} и ${b.name} получают по +${CONSOLATION} БешКоинов за смелость.`,
    );
    return;
  }
  const winner = tally[0] > tally[1] ? a : b;
  await awardCoins(ctx.admin, ctx.chatId, winner.id, WIN_REWARD, "game_win", {
    game: "excuse_duel",
  });
  await telegram.sendMessage(
    ctx.telegramChatId,
    `🏆 Победа за ${winner.name} (${Math.max(tally[0], tally[1])}:${Math.min(tally[0], tally[1])})! +${WIN_REWARD} БешКоинов за самую убедительную дичь.`,
  );
}
