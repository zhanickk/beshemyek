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
import { truncateBtn } from "@/lib/keyboards.server";

const LOBBY_MS = 120 * 1000;
const QUESTION_MS = 30 * 1000;
const NUM_QUESTIONS = 5;
const WIN_REWARD = 40;

interface DuelQuestion {
  q: string;
  options: string[];
  correct: number;
}

type Phase = "lobby" | "playing" | "done";

interface QuizDuelState {
  phase: Phase;
  challenger: { id: number; name: string };
  opponent: { id: number; name: string } | null;
  questions: DuelQuestion[];
  qIndex: number;
  scores: Record<string, number>;
  answered: number[]; // duelists who already answered the current question
  qMessageId?: number;
  lobbyMessageId?: number;
  deadlineAt: string;
  [key: string]: unknown;
}

async function loadQuestions(ctx: GameCtx): Promise<DuelQuestion[]> {
  const { data } = await ctx.admin
    .from("quiz_questions")
    .select("question, options, correct_option")
    .eq("category", "aiesec")
    .eq("is_active", true)
    .not("correct_option", "is", null);
  const pool = (data ?? [])
    .filter((r: any) => Array.isArray(r.options) && r.correct_option != null)
    .map((r: any) => ({
      q: r.question as string,
      options: r.options as string[],
      correct: r.correct_option as number,
    }));
  const shuffled = pool.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, NUM_QUESTIONS);
}

export async function startQuizDuel(ctx: GameCtx, challenger: { id: number; name: string }) {
  const existing = await getActiveSession(ctx.admin, ctx.chatId);
  if (existing) return { alreadyActive: true as const };

  const questions = await loadQuestions(ctx);
  if (questions.length < 3) return { notEnough: true as const };

  const state: QuizDuelState = {
    phase: "lobby",
    challenger,
    opponent: null,
    questions,
    qIndex: 0,
    scores: {},
    answered: [],
    deadlineAt: new Date(Date.now() + LOBBY_MS).toISOString(),
  };
  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "quiz_duel",
    state,
    challenger.id,
    "active",
  );

  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    `⚔️ <b>Квиз-дуэль 1×1!</b>\n${challenger.name} бросает вызов. Блиц из ${questions.length} вопросов, победитель забирает ${WIN_REWARD} БешКоинов.\nКто примет вызов?`,
    {
      reply_markup: inlineKeyboard([
        [{ text: "Принять дуэль", callback_data: packCallback(session.short_code, "acc") }],
        [{ text: "Отказаться", callback_data: packCallback(session.short_code, "dec") }],
      ]),
    },
  );
  const lobbyMessageId = sent?.result?.message_id;
  if (lobbyMessageId) await updateSessionState(ctx.admin, session.id, { ...state, lobbyMessageId });
  return { session };
}

async function postQuestion(ctx: GameCtx, session: GameSession, state: QuizDuelState) {
  const q = state.questions[state.qIndex];
  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    `❓ <b>Вопрос ${state.qIndex + 1}/${state.questions.length}</b>\n${q.q}`,
    {
      reply_markup: inlineKeyboard(
        q.options.map((opt, i) => {
          const letters = ["А", "Б", "В", "Г"];
          return [
            {
              text: truncateBtn(`${letters[i] ?? i + 1}. ${opt}`),
              callback_data: packCallback(session.short_code, "a", String(i)),
            },
          ];
        }),
      ),
    },
  );
  const qMessageId = sent?.result?.message_id;
  const next: QuizDuelState = {
    ...state,
    answered: [],
    qMessageId,
    deadlineAt: new Date(Date.now() + QUESTION_MS).toISOString(),
  };
  await updateSessionState(ctx.admin, session.id, next);
}

async function advance(ctx: GameCtx, session: GameSession, state: QuizDuelState) {
  if (state.qMessageId) {
    await telegram.editMessageReplyMarkup(ctx.telegramChatId, state.qMessageId, undefined);
  }
  const nextIndex = state.qIndex + 1;
  if (nextIndex >= state.questions.length) {
    await finishDuel(ctx, session, state);
    return;
  }
  await postQuestion(ctx, session, { ...state, qIndex: nextIndex });
}

async function finishDuel(ctx: GameCtx, session: GameSession, state: QuizDuelState) {
  const c = state.challenger;
  const o = state.opponent!;
  const cScore = state.scores[String(c.id)] ?? 0;
  const oScore = state.scores[String(o.id)] ?? 0;
  await finishSession(ctx.admin, session.id, { ...state, phase: "done" });

  let msg = `🏁 <b>Дуэль окончена!</b>\n${c.name}: ${cScore} • ${o.name}: ${oScore}\n\n`;
  if (cScore === oScore) {
    msg += "Ничья! Оба хороши, коины остаются при своих.";
  } else {
    const winner = cScore > oScore ? c : o;
    await awardCoins(ctx.admin, ctx.chatId, winner.id, WIN_REWARD, "game_win", {
      game: "quiz_duel",
    });
    msg += `🏆 Побеждает ${winner.name}! +${WIN_REWARD} БешКоинов.`;
  }
  await telegram.sendMessage(ctx.telegramChatId, msg);
}

export async function handleQuizDuelCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  payload: string,
  callbackQueryId: string,
  presser: { id: number; name: string },
) {
  const state = session.state as QuizDuelState;

  if (action === "dec") {
    if (state.phase !== "lobby") {
      await telegram.answerCallbackQuery(callbackQueryId);
      return;
    }
    await telegram.answerCallbackQuery(callbackQueryId, "Ок, без дуэли");
    if (state.lobbyMessageId) {
      await telegram.editMessageText(
        ctx.telegramChatId,
        state.lobbyMessageId,
        `🏳 ${presser.name} отказался от дуэли. Вызов ${state.challenger.name} снят.`,
      );
    }
    await finishSession(ctx.admin, session.id, { ...state, phase: "done", declined: true });
    return;
  }

  if (action === "acc") {
    if (state.phase !== "lobby") {
      await telegram.answerCallbackQuery(callbackQueryId, "Вызов уже принят.", true);
      return;
    }
    if (presser.id === state.challenger.id) {
      await telegram.answerCallbackQuery(callbackQueryId, "Свой же вызов принять нельзя 😄", true);
      return;
    }
    await telegram.answerCallbackQuery(callbackQueryId, "Вызов принят! Погнали ⚔️");
    if (state.lobbyMessageId) {
      await telegram.editMessageReplyMarkup(ctx.telegramChatId, state.lobbyMessageId, undefined);
    }
    const playing: QuizDuelState = {
      ...state,
      phase: "playing",
      opponent: { id: presser.id, name: presser.name },
      qIndex: 0,
      scores: { [String(state.challenger.id)]: 0, [String(presser.id)]: 0 },
    };
    await telegram.sendMessage(
      ctx.telegramChatId,
      `⚔️ ${state.challenger.name} 🆚 ${presser.name}! Отвечать могут только дуэлянты. Кто первый даёт верный ответ — забирает очко.`,
    );
    await postQuestion(ctx, session, playing);
    return;
  }

  if (action === "a") {
    if (state.phase !== "playing" || !state.opponent) {
      await telegram.answerCallbackQuery(callbackQueryId);
      return;
    }
    const isDuelist = presser.id === state.challenger.id || presser.id === state.opponent.id;
    if (!isDuelist) {
      await telegram.answerCallbackQuery(callbackQueryId, "Ты не участник этой дуэли 🙂", true);
      return;
    }
    if (state.answered.includes(presser.id)) {
      await telegram.answerCallbackQuery(
        callbackQueryId,
        "Ты уже ответил(а) на этот вопрос.",
        true,
      );
      return;
    }
    const q = state.questions[state.qIndex];
    const choice = Number(payload);
    const correct = choice === q.correct;
    const answered = [...state.answered, presser.id];
    const scores = { ...state.scores };
    let resolved = false;

    if (correct) {
      scores[String(presser.id)] = (scores[String(presser.id)] ?? 0) + 1;
      await telegram.answerCallbackQuery(callbackQueryId, "Верно! +1 очко ✅");
      resolved = true; // first correct answer ends the question
    } else {
      await telegram.answerCallbackQuery(callbackQueryId, "Мимо ❌");
    }

    const bothAnswered = answered.length >= 2;
    const updated: QuizDuelState = { ...state, answered, scores };

    if (resolved || bothAnswered) {
      await advance(ctx, session, updated);
    } else {
      await updateSessionState(ctx.admin, session.id, updated);
    }
    return;
  }

  await telegram.answerCallbackQuery(callbackQueryId);
}

export async function tickQuizDuel(ctx: GameCtx, session: GameSession) {
  const state = session.state as QuizDuelState;
  if (!state.deadlineAt || Date.now() < new Date(state.deadlineAt).getTime()) return;

  if (state.phase === "lobby") {
    if (state.lobbyMessageId) {
      await telegram.editMessageReplyMarkup(ctx.telegramChatId, state.lobbyMessageId, undefined);
    }
    await finishSession(ctx.admin, session.id, { ...state, phase: "done" });
    await telegram.sendMessage(
      ctx.telegramChatId,
      `Никто не принял вызов ${state.challenger.name}. Дуэль отменяется 🤷`,
    );
    return;
  }

  if (state.phase === "playing") {
    // Nobody answered in time → reveal correct answer and move on.
    const q = state.questions[state.qIndex];
    await telegram.sendMessage(
      ctx.telegramChatId,
      `⏱ Время вышло! Правильный ответ: <b>${q.options[q.correct]}</b>.`,
    );
    await advance(ctx, session, state);
  }
}
