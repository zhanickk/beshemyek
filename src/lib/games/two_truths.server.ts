import type { SupabaseClient } from "@supabase/supabase-js";
import { telegram, inlineKeyboard, tgDisplayName } from "@/lib/telegram.server";
import { truncateBtn } from "@/lib/keyboards.server";
import { awardCoins } from "@/lib/economy.server";
import {
  createSession,
  getActiveSession,
  finishSession,
  packCallback,
  type GameCtx,
  type GameSession,
} from "./engine.server";

const ROUND_MS = 10 * 60 * 1000;
const LETTERS = ["А", "Б", "В"];

export async function beginTwoTruthsDialog(
  admin: SupabaseClient,
  telegramUserId: number,
  chatId: string,
) {
  await admin.from("bot_dialogs").upsert({
    telegram_user_id: telegramUserId,
    kind: "two_truths_submit",
    state: { chatId, step: 1, facts: [] },
  });
  await telegram.sendMessage(
    telegramUserId,
    "🎭 <b>Два правды и одна ложь</b>\nПришли факт 1 из 3 (правда или ложь — сам выберешь позже):",
  );
}

/** Returns true if the message was consumed by the dialog. */
export async function handleTwoTruthsDialogMessage(
  admin: SupabaseClient,
  dialog: { telegram_user_id: number; state: any },
  text: string,
  fromName: string,
): Promise<boolean> {
  const state = dialog.state;
  if (state.step === 1 || state.step === 2 || state.step === 3) {
    const facts = [...state.facts, text.trim()];
    if (facts.length < 3) {
      await admin
        .from("bot_dialogs")
        .update({ state: { ...state, step: facts.length + 1, facts } })
        .eq("telegram_user_id", dialog.telegram_user_id);
      await telegram.sendMessage(dialog.telegram_user_id, `Факт ${facts.length + 1} из 3:`);
      return true;
    }
    await admin
      .from("bot_dialogs")
      .update({ state: { ...state, step: "lie", facts } })
      .eq("telegram_user_id", dialog.telegram_user_id);
    await telegram.sendMessage(
      dialog.telegram_user_id,
      `Готово! Теперь выбери, какой из них ложь:\n${facts.map((f: string, i: number) => `${LETTERS[i]}. ${f}`).join("\n")}`,
      {
        reply_markup: inlineKeyboard([
          facts.map((_: string, i: number) => ({ text: LETTERS[i], callback_data: `tt_lie:${i}` })),
        ]),
      },
    );
    return true;
  }
  return false;
}

export async function finalizeTwoTruths(
  admin: SupabaseClient,
  dialog: { telegram_user_id: number; state: any },
  lieIndex: number,
  submitterName: string,
) {
  const chatId = dialog.state.chatId;
  const { data: chatRow } = await admin
    .from("chats")
    .select("telegram_chat_id")
    .eq("id", chatId)
    .maybeSingle();
  if (!chatRow) {
    await admin.from("bot_dialogs").delete().eq("telegram_user_id", dialog.telegram_user_id);
    return;
  }
  const existing = await getActiveSession(admin, chatId);
  if (existing) {
    await admin.from("bot_dialogs").delete().eq("telegram_user_id", dialog.telegram_user_id);
    await telegram.sendMessage(
      dialog.telegram_user_id,
      "В чате сейчас идёт другая игра, попробуй чуть позже через /two_truths.",
    );
    return;
  }
  const facts: string[] = dialog.state.facts;
  const session = await createSession(
    admin,
    chatId,
    "two_truths",
    {
      facts,
      lieIndex,
      submitterId: dialog.telegram_user_id,
      submitterName,
      votes: {},
      deadlineAt: new Date(Date.now() + ROUND_MS).toISOString(),
    },
    dialog.telegram_user_id,
    "active",
  );
  const rows = facts.map((f, i) => [
    {
      text: truncateBtn(`${LETTERS[i]}. ${f}`),
      callback_data: packCallback(session.short_code, "vote", String(i)),
    },
  ]);
  await telegram.sendMessage(
    chatRow.telegram_chat_id,
    `🎭 <b>Два правды и одна ложь</b>\nАнонимный участник прислал 3 факта. Угадайте, какой — ложь!\n\n${facts.map((f, i) => `${LETTERS[i]}. ${f}`).join("\n")}\n\nУ вас ${ROUND_MS / 60000} минут.`,
    { reply_markup: inlineKeyboard(rows) },
  );
  await admin.from("bot_dialogs").delete().eq("telegram_user_id", dialog.telegram_user_id);
  await telegram.sendMessage(dialog.telegram_user_id, "Опубликовал в чате анонимно! 🤫");
}

export async function handleTwoTruthsCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  payload: string,
  callbackQueryId: string,
  voterId: number,
) {
  if (action !== "vote") return;
  if (voterId === session.state.submitterId) {
    await telegram.answerCallbackQuery(
      callbackQueryId,
      "Нельзя голосовать за свой же пост 😏",
      true,
    );
    return;
  }
  const votes = { ...(session.state.votes ?? {}), [String(voterId)]: payload };
  await ctx.admin
    .from("game_sessions")
    .update({ state: { ...session.state, votes } })
    .eq("id", session.id);
  await telegram.answerCallbackQuery(callbackQueryId, "Голос принят!");
}

export async function tickTwoTruths(ctx: GameCtx, session: GameSession) {
  if (new Date(session.state.deadlineAt).getTime() > Date.now()) return;
  const lieIndex = String(session.state.lieIndex);
  const votes: Record<string, string> = session.state.votes ?? {};
  const winners = Object.entries(votes)
    .filter(([, v]) => v === lieIndex)
    .map(([voter]) => Number(voter));
  for (const voterId of winners) {
    await awardCoins(ctx.admin, ctx.chatId, voterId, 10, "game_win", { game: "two_truths" });
  }
  await awardCoins(ctx.admin, ctx.chatId, session.state.submitterId, 5, "game_win", {
    game: "two_truths_submitter",
  });
  await finishSession(ctx.admin, session.id, session.state);
  await telegram.sendMessage(
    ctx.telegramChatId,
    `Ложью был вариант <b>${LETTERS[Number(lieIndex)]}</b>: «${session.state.facts[Number(lieIndex)]}»\n${winners.length > 0 ? `Угадали: ${winners.length} чел. (+10 БешКоинов)` : "Никто не угадал!"}`,
  );
}
