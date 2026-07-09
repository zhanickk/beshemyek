import { telegram, inlineKeyboard, tgDisplayName } from "@/lib/telegram.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { awardCoins } from "@/lib/economy.server";
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
import { ensureQuoteBank, fetchQuoteEntry } from "./quote-bank.server";

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

function memberLabel(
  displayName?: string | null,
  username?: string | null,
  firstName?: string | null,
  lastName?: string | null,
): string | null {
  const trimmed = displayName?.trim();
  if (trimmed) return trimmed;
  if (username) return `@${username}`;
  const fromTg = tgDisplayName({ first_name: firstName ?? undefined, last_name: lastName ?? undefined, username: username ?? undefined });
  return fromTg !== "кто-то" ? fromTg : null;
}

function extractFromUser(raw: unknown): {
  first_name?: string;
  last_name?: string;
  username?: string;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const from =
    (r.message as { from?: unknown } | undefined)?.from ??
    (r.edited_message as { from?: unknown } | undefined)?.from ??
    (r.callback_query as { from?: unknown } | undefined)?.from;
  if (!from || typeof from !== "object") return null;
  return from as { first_name?: string; last_name?: string; username?: string };
}

/** Prefer display name or @username; never show raw #telegram_user_id in buttons. */
async function resolveMemberLabels(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  userIds: number[],
): Promise<Map<number, string>> {
  const uniq = [...new Set(userIds)];
  const out = new Map<number, string>();
  if (!uniq.length) return out;

  const { data: members } = await admin
    .from("chat_members")
    .select("telegram_user_id, username, display_name")
    .eq("chat_id", chatId)
    .in("telegram_user_id", uniq);

  for (const m of members ?? []) {
    const label = memberLabel(m.display_name, m.username);
    if (label) out.set(m.telegram_user_id, label);
  }

  let missing = uniq.filter((id) => !out.has(id));
  if (missing.length) {
    const { data: logs } = await admin
      .from("messages_log")
      .select("from_user_id, from_username, raw")
      .eq("telegram_chat_id", telegramChatId)
      .in("from_user_id", missing)
      .order("created_at", { ascending: false })
      .limit(missing.length * 5);

    for (const row of logs ?? []) {
      const uid = row.from_user_id;
      if (!uid || out.has(uid)) continue;
      const from = extractFromUser(row.raw);
      const label = memberLabel(
        null,
        row.from_username ?? from?.username ?? null,
        from?.first_name ?? null,
        from?.last_name ?? null,
      );
      if (label) out.set(uid, label);
    }
  }

  missing = uniq.filter((id) => !out.has(id));
  for (const id of missing) {
    try {
      const res: any = await telegram.getChatMember(telegramChatId, id);
      const label = memberLabel(null, res?.result?.user?.username, res?.result?.user?.first_name, res?.result?.user?.last_name);
      if (label) out.set(id, label);
    } catch {
      // user may have left the chat
    }
  }

  return out;
}

function memberName(m: {
  display_name?: string | null;
  username?: string | null;
  telegram_user_id: number;
  resolved?: string;
}) {
  return m.resolved ?? memberLabel(m.display_name, m.username) ?? "Участник чата";
}

export async function startCringeGame(ctx: GameCtx, mode: CringeMode) {
  const existing = await getBlockingSession(ctx.admin, ctx.chatId, "cringe");
  if (existing) return { alreadyActive: true as const };

  await ensureQuoteBank(ctx.admin, ctx.chatId, ctx.telegramChatId, mode);
  const entry = await fetchQuoteEntry(ctx.admin, ctx.chatId, mode, ctx.telegramChatId);
  if (!entry) return { noEntries: true as const };

  const { data: members } = await ctx.admin
    .from("chat_members")
    .select("telegram_user_id, username, display_name")
    .eq("chat_id", ctx.chatId)
    .limit(40);

  const pool = (members ?? [])
    .filter((m) => m.telegram_user_id !== entry.telegram_user_id)
    .sort((a, b) => {
      const aNamed = Number(!!(a.display_name?.trim() || a.username));
      const bNamed = Number(!!(b.display_name?.trim() || b.username));
      return bNamed - aNamed || Math.random() - 0.5;
    });
  const distractorCount = Math.min(3, pool.length);
  const distractors = pool.slice(0, distractorCount);
  const subjectMember = (members ?? []).find(
    (m) => m.telegram_user_id === entry.telegram_user_id,
  ) ?? {
    telegram_user_id: entry.telegram_user_id,
    username: null,
    display_name: null,
  };
  const labelMap = await resolveMemberLabels(
    ctx.admin,
    ctx.chatId,
    ctx.telegramChatId,
    [subjectMember.telegram_user_id, ...distractors.map((d) => d.telegram_user_id)],
  );
  const withLabels = (m: {
    telegram_user_id: number;
    username: string | null;
    display_name: string | null;
  }) => ({
    ...m,
    resolved: labelMap.get(m.telegram_user_id),
  });
  const subject = withLabels(subjectMember);
  const distractorsLabeled = distractors
    .map(withLabels)
    .filter((c) => memberName(c) !== "Участник чата");
  if (memberName(subject) === "Участник чата") return { noEntries: true as const };
  const candidates = [subject, ...distractorsLabeled].sort(() => Math.random() - 0.5);

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
      text: truncateBtn(`👤 ${memberName(c)}`),
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
    session.state.candidates.find((c: any) => String(c.id) === subjectId)?.name ?? "Участник чата";
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
    session.state.candidates.find((c: any) => String(c.id) === subjectId)?.name ?? "Участник чата";
  await finishSession(ctx.admin, session.id, session.state);
  const msgId = session.state.messageId;
  const body =
    `${LABELS[(session.state.mode ?? "cringe") as CringeMode].intro}\n\n` +
    `«${session.state.quoteText}»\n\n` +
    `⏰ Время вышло. <b>Правильный ответ:</b> ${subjectName}`;
  if (msgId) await telegram.editMessageText(ctx.telegramChatId, msgId, body);
  else await telegram.sendMessage(ctx.telegramChatId, body);
}
