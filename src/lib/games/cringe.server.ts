import { telegram, inlineKeyboard } from "@/lib/telegram.server";
import { awardCoins } from "@/lib/economy.server";
import { truncateBtn } from "@/lib/keyboards.server";
import {
  createSession,
  getActiveSession,
  finishSession,
  updateSessionState,
  packCallback,
  type GameCtx,
  type GameSession,
} from "./engine.server";

const ROUND_MS = 2 * 60 * 1000;

export type CringeMode = "cringe" | "who_said";

const LABELS = {
  cringe: {
    intro: "🫠 <b>Кто этот Кринж?</b>",
    question: "Кто это спалился?",
  },
  who_said: {
    intro: "🗣 <b>Кто это сказал?</b>",
    question: "Чья это цитата?",
  },
};

function memberName(m: {
  display_name?: string | null;
  username?: string | null;
  telegram_user_id: number;
}) {
  return m.display_name || (m.username ? `@${m.username}` : `#${m.telegram_user_id}`);
}

export async function startCringeGame(ctx: GameCtx, mode: CringeMode) {
  const existing = await getActiveSession(ctx.admin, ctx.chatId);
  if (existing) return { alreadyActive: true as const };

  let { data: entries } = await ctx.admin
    .from("cringe_entries")
    .select("*")
    .eq("chat_id", ctx.chatId)
    .eq("is_active", true)
    .eq("is_used", false);

  if (!entries || entries.length === 0) {
    await ctx.admin
      .from("cringe_entries")
      .update({ is_used: false })
      .eq("chat_id", ctx.chatId)
      .eq("is_active", true);
    const retry = await ctx.admin
      .from("cringe_entries")
      .select("*")
      .eq("chat_id", ctx.chatId)
      .eq("is_active", true);
    entries = retry.data ?? [];
  }
  if (!entries || entries.length === 0) return { noEntries: true as const };

  const entry = entries[Math.floor(Math.random() * entries.length)];
  await ctx.admin
    .from("cringe_entries")
    .update({ is_used: true, used_at: new Date().toISOString() })
    .eq("id", entry.id);

  const { data: members } = await ctx.admin
    .from("chat_members")
    .select("telegram_user_id, username, display_name")
    .eq("chat_id", ctx.chatId)
    .limit(30);

  const pool = (members ?? []).filter((m) => m.telegram_user_id !== entry.telegram_user_id);
  const distractors = pool.sort(() => Math.random() - 0.5).slice(0, 3);
  const subjectMember = (members ?? []).find(
    (m) => m.telegram_user_id === entry.telegram_user_id,
  ) ?? {
    telegram_user_id: entry.telegram_user_id,
    username: null,
    display_name: null,
  };
  const candidates = [subjectMember, ...distractors].sort(() => Math.random() - 0.5);

  if (candidates.length < 2) return { noEntries: true as const };

  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "cringe",
    {
      mode,
      entryId: entry.id,
      subjectId: entry.telegram_user_id,
      quoteText: entry.quote_text,
      candidates: candidates.map((c) => ({ id: c.telegram_user_id, name: memberName(c) })),
      votes: {},
      deadlineAt: new Date(Date.now() + ROUND_MS).toISOString(),
    },
    null,
    "active",
  );

  const rows = candidates.map((c) => [
    {
      text: truncateBtn(memberName(c)),
      callback_data: packCallback(session.short_code, "vote", String(c.telegram_user_id)),
    },
  ]);

  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    `${LABELS[mode].intro}\n\n«${entry.quote_text}»\n\n${LABELS[mode].question} У вас ${ROUND_MS / 60000} минуты.`,
    { reply_markup: inlineKeyboard(rows) },
  );
  const messageId = sent?.result?.message_id;
  if (messageId) {
    await updateSessionState(ctx.admin, session.id, { ...session.state, messageId });
  }
  return { session };
}

async function revealCringeAnswer(
  ctx: GameCtx,
  session: GameSession,
  voterId: number,
  pickedId: string,
) {
  const subjectId = String(session.state.subjectId);
  const subjectName =
    session.state.candidates.find((c: any) => String(c.id) === subjectId)?.name ?? `#${subjectId}`;
  const correct = pickedId === subjectId;
  if (correct) {
    await awardCoins(ctx.admin, ctx.chatId, voterId, 10, "game_win", {
      game: session.state.mode ?? "cringe",
    });
  }
  await finishSession(ctx.admin, session.id, { ...session.state, revealed: true, winnerId: voterId });
  const msgId = session.state.messageId;
  const body =
    `${LABELS[(session.state.mode ?? "cringe") as CringeMode].intro}\n\n` +
    `«${session.state.quoteText}»\n\n` +
    `✅ <b>Правильный ответ:</b> ${subjectName}\n` +
    (correct ? "🎯 Угадал(а)! +10 БешКоинов." : "❌ Мимо, но теперь все знают правду.");
  if (msgId) {
    await telegram.editMessageText(ctx.telegramChatId, msgId, body);
  } else {
    await telegram.sendMessage(ctx.telegramChatId, body);
  }
}

export async function handleCringeCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  payload: string,
  callbackQueryId: string,
  voterId: number,
) {
  if (action !== "vote" || session.state.revealed) return;
  const votes = { ...(session.state.votes ?? {}) };
  votes[String(voterId)] = payload;
  await updateSessionState(ctx.admin, session.id, { ...session.state, votes });
  await telegram.answerCallbackQuery(callbackQueryId, "Смотрим ответ...");
  await revealCringeAnswer(ctx, { ...session, state: { ...session.state, votes } }, voterId, payload);
}

export async function tickCringe(ctx: GameCtx, session: GameSession) {
  if (session.state.revealed) return;
  if (new Date(session.state.deadlineAt).getTime() > Date.now()) return;
  const subjectId = String(session.state.subjectId);
  const subjectName =
    session.state.candidates.find((c: any) => String(c.id) === subjectId)?.name ?? `#${subjectId}`;
  await finishSession(ctx.admin, session.id, session.state);
  const msgId = session.state.messageId;
  const body =
    `${LABELS[(session.state.mode ?? "cringe") as CringeMode].intro}\n\n` +
    `«${session.state.quoteText}»\n\n` +
    `⏰ Время вышло. <b>Правильный ответ:</b> ${subjectName}`;
  if (msgId) await telegram.editMessageText(ctx.telegramChatId, msgId, body);
  else await telegram.sendMessage(ctx.telegramChatId, body);
}
