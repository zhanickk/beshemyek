import { telegram, inlineKeyboard } from "@/lib/telegram.server";
import { truncateBtn } from "@/lib/keyboards.server";
import {
  createSession,
  finishSession,
  getActiveSession,
  packCallback,
  type GameCtx,
  type GameSession,
} from "./engine.server";

const ARCHETYPE_DESCRIPTIONS: Record<string, string> = {
  лидер: "Ты прирождённый LCP — организуешь, ведёшь, вдохновляешь. 👑",
  хайп: "Ты душа движа — заряжаешь чат энергией не хуже редбула. ⚡",
  мемолог: "Ты официальный министр мемов локалки. 😂",
  трудяга: "Ты незаменимый трудяга — тихо тащишь любой проект. 💪",
  философ: "Ты философ движа — видишь смысл там, где другие видят KPI. 🧠",
};

async function sendQuestion(ctx: GameCtx, session: GameSession) {
  const q = session.state.questions[session.state.currentIndex];
  await telegram.sendMessage(
    ctx.telegramChatId,
    `<b>Вопрос ${session.state.currentIndex + 1}/${session.state.questions.length}:</b> ${q.question}`,
    {
      reply_markup: inlineKeyboard(
        q.options.map((opt: string, i: number) => {
          const letters = ["А", "Б", "В", "Г", "Д"];
          return [
            {
              text: truncateBtn(`${letters[i] ?? i + 1}. ${opt}`),
              callback_data: packCallback(session.short_code, "ans", String(i)),
            },
          ];
        }),
      ),
    },
  );
}

export async function startArchetypeQuiz(ctx: GameCtx, invoker: { id: number; name: string }) {
  const existing = await getActiveSession(ctx.admin, ctx.chatId);
  if (existing) return { alreadyActive: true as const };
  const { data: pool } = await ctx.admin
    .from("quiz_questions")
    .select("*")
    .eq("category", "archetype")
    .eq("is_active", true);
  if (!pool || pool.length === 0) return { noQuestions: true as const };
  const questions = [...pool].sort(() => Math.random() - 0.5).slice(0, 5);

  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "archetype_quiz",
    { invokerId: invoker.id, invokerName: invoker.name, questions, currentIndex: 0, tally: {} },
    invoker.id,
    "active",
  );
  await telegram.sendMessage(
    ctx.telegramChatId,
    `🧪 <b>Какой ты тип мембера AIESEC?</b> ${invoker.name} проходит тест!`,
  );
  await sendQuestion(ctx, session);
  return { session };
}

export async function handleArchetypeCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  payload: string,
  callbackQueryId: string,
  fromUserId: number,
) {
  if (action !== "ans") return;
  if (fromUserId !== session.state.invokerId) {
    await telegram.answerCallbackQuery(callbackQueryId, "Это не твой тест 😏", true);
    return;
  }
  const q = session.state.questions[session.state.currentIndex];
  const tag = q.meta?.tags?.[Number(payload)] ?? "философ";
  const tally = { ...(session.state.tally ?? {}) };
  tally[tag] = (tally[tag] ?? 0) + 1;
  await telegram.answerCallbackQuery(callbackQueryId, "Принято!");

  const nextIndex = session.state.currentIndex + 1;
  if (nextIndex < session.state.questions.length) {
    const state = { ...session.state, currentIndex: nextIndex, tally };
    await ctx.admin.from("game_sessions").update({ state }).eq("id", session.id);
    await sendQuestion(ctx, { ...session, state } as GameSession);
    return;
  }

  const topTag = Object.entries(tally as Record<string, number>).sort((a, b) => b[1] - a[1])[0][0];
  await finishSession(ctx.admin, session.id, { ...session.state, tally, result: topTag });
  await telegram.sendMessage(
    ctx.telegramChatId,
    `🧪 <b>${session.state.invokerName}, твой архетип:</b>\n${ARCHETYPE_DESCRIPTIONS[topTag] ?? topTag}`,
  );
}
