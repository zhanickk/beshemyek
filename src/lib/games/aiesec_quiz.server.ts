import { telegram, inlineKeyboard } from "@/lib/telegram.server";
import { awardCoins } from "@/lib/economy.server";
import { optionLetterButtons } from "@/lib/keyboards.server";
import {
  createSession,
  getBlockingSession,
  finishSession,
  packCallback,
  type GameCtx,
  type GameSession,
} from "./engine.server";

const ROUND_MS = 2 * 60 * 1000;

export async function startAiesecQuiz(ctx: GameCtx) {
  const existing = await getBlockingSession(ctx.admin, ctx.chatId, "aiesec_quiz");
  if (existing) return { alreadyActive: true as const };

  const { data: questions } = await ctx.admin
    .from("quiz_questions")
    .select("*")
    .eq("category", "aiesec")
    .eq("is_active", true);
  const filtered = (questions ?? []).filter((q) => q.language === ctx.lang);
  const pool = filtered.length > 0 ? filtered : (questions ?? []);
  if (pool.length === 0) return { noQuestions: true as const };

  const q = pool[Math.floor(Math.random() * pool.length)];
  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "aiesec_quiz",
    {
      question: q.question,
      options: q.options,
      correct: q.correct_option,
      answers: {},
      deadlineAt: new Date(Date.now() + ROUND_MS).toISOString(),
    },
    null,
    "active",
  );

  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    `🎓 <b>AIESEC квиз</b>\n${q.question}`,
    {
      reply_markup: inlineKeyboard(
        optionLetterButtons(q.options, (i) => packCallback(session.short_code, "ans", String(i))),
      ),
    },
  );
  const messageId = sent?.result?.message_id;
  if (messageId) {
    await ctx.admin
      .from("game_sessions")
      .update({ state: { ...session.state, messageId } })
      .eq("id", session.id);
  }
  return { ok: true as const };
}

export async function handleAiesecQuizCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  payload: string,
  callbackQueryId: string,
  voterId: number,
) {
  if (action !== "ans") return;
  const answers: Record<string, number> = session.state.answers ?? {};
  if (answers[String(voterId)] !== undefined) {
    await telegram.answerCallbackQuery(callbackQueryId, "Ты уже ответил(а)!", true);
    return;
  }
  const choice = Number(payload);
  const correct = choice === session.state.correct;
  answers[String(voterId)] = choice;
  if (correct) {
    await awardCoins(ctx.admin, ctx.chatId, voterId, 10, "game_win", { game: "aiesec_quiz" });
  }
  await telegram.answerCallbackQuery(callbackQueryId, correct ? "Верно! +10 🪙" : "Мимо ❌");

  const correctOpt = session.state.options[session.state.correct];
  const msgId = session.state.messageId;
  const body =
    `🎓 <b>AIESEC квиз</b>\n${session.state.question}\n\n` +
    `✅ Правильный ответ: <b>${correctOpt}</b>`;
  if (msgId) await telegram.editMessageText(ctx.telegramChatId, msgId, body);
  await finishSession(ctx.admin, session.id, { ...session.state, answers, finished: true });
}

export async function tickAiesecQuiz(ctx: GameCtx, session: GameSession) {
  if (!session.state.deadlineAt || new Date(session.state.deadlineAt).getTime() > Date.now()) return;
  if (session.state.finished) return;

  const correctOpt = session.state.options[session.state.correct];
  const msgId = session.state.messageId;
  const body =
    `🎓 <b>AIESEC квиз</b>\n${session.state.question}\n\n` +
    `⏰ Время вышло!\n✅ Правильный ответ: <b>${correctOpt}</b>`;
  if (msgId) await telegram.editMessageText(ctx.telegramChatId, msgId, body);
  await finishSession(ctx.admin, session.id, { ...session.state, finished: true });
}
