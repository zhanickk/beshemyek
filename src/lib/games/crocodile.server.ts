import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { telegram, inlineKeyboard, buildDeepLink, chatMemberTag } from "@/lib/telegram.server";
import { lookupMemberTag } from "@/lib/member-tag.server";
import { awardCoins } from "@/lib/economy.server";
import {
  createSession,
  getBlockingSession,
  getSessionByShortCode,
  updateSessionState,
  packCallback,
  type GameCtx,
  type GameSession,
} from "./engine.server";
import { randomCrocodileWord, containsWord } from "./crocodile-words";

const ROUND_MS = 3 * 60 * 1000;

type CrocodilePhase = "playing" | "pick_explainer";

interface CrocodileVolunteer {
  id: number;
  name: string;
}

function genPickToken() {
  return randomBytes(4).toString("hex");
}

function resolveCrocodilePhase(state: Record<string, unknown>): CrocodilePhase {
  if (state.phase === "priority_window" || state.phase === "pick_explainer") return "pick_explainer";
  if (state.phase === "playing" && state.explainerId && state.word) return "playing";
  if (state.explainerId && state.word) return "playing";
  return "pick_explainer";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildPickExplainerState(session: GameSession): Record<string, unknown> {
  const prevExplainerId = session.state.explainerId as number | undefined;
  const prevExplainerName = session.state.explainerName as string | undefined;
  const usedWords = [...(session.state.usedWords ?? [])];
  if (session.state.word) usedWords.push(session.state.word);

  return {
    phase: "pick_explainer" as CrocodilePhase,
    lastExplainerId: prevExplainerId,
    lastExplainerName: prevExplainerName,
    usedWords,
    pickToken: genPickToken(),
    explainerId: undefined,
    explainerName: undefined,
    word: undefined,
    category: undefined,
    deadlineAt: undefined,
    skippedWords: undefined,
    gameMessageId: undefined,
    pickMessageId: undefined,
    explainerDmMessageId: undefined,
  };
}

function playingKeyboard(shortCode: string) {
  return inlineKeyboard([
    [
      { text: "💡 Подсказка", callback_data: packCallback(shortCode, "hint") },
      { text: "🏳 Сдаться", callback_data: packCallback(shortCode, "surrender") },
    ],
  ]);
}

function volunteerKeyboard(shortCode: string) {
  return inlineKeyboard([[{ text: "🐊 Загадать", callback_data: packCallback(shortCode, "volunteer") }]]);
}

function explainerDmKeyboard(shortCode: string) {
  return inlineKeyboard([[{ text: "🔄 Другое слово", callback_data: packCallback(shortCode, "skip") }]]);
}

function explainerWordBody(word: string, category: string): string {
  return (
    `🐊 Твоё слово для Крокодила: <b>${escapeHtml(word)}</b>\n` +
    `Категория: «${escapeHtml(category)}»\n` +
    `Объясни его чату, не называя впрямую и без однокоренных слов!\n\n` +
    `Не знаешь слово? Жми «Другое слово» или напиши /skip`
  );
}

/** Edit the explainer's DM in place when possible so the old word doesn't linger. */
async function publishExplainerWord(
  ctx: GameCtx,
  session: GameSession,
  telegramUserId: number,
  preferredMessageId?: number,
): Promise<void> {
  const word = String(session.state.word ?? "");
  const category = String(session.state.category ?? "");
  const body = explainerWordBody(word, category);
  const keyboard = explainerDmKeyboard(session.short_code);
  const storedId = (session.state.explainerDmMessageId as number | undefined) ?? preferredMessageId;

  if (storedId) {
    try {
      await telegram.editMessageText(telegramUserId, storedId, body, { reply_markup: keyboard });
      if (storedId !== session.state.explainerDmMessageId) {
        const nextState = { ...session.state, explainerDmMessageId: storedId };
        await updateSessionState(ctx.admin, session.id, nextState);
        session.state = nextState;
      }
      return;
    } catch (e) {
      console.error("crocodile DM edit failed", e);
    }
  }

  const sent: any = await telegram.sendMessage(telegramUserId, body, { reply_markup: keyboard });
  const messageId = sent?.result?.message_id as number | undefined;
  if (messageId) {
    const nextState = { ...session.state, explainerDmMessageId: messageId };
    await updateSessionState(ctx.admin, session.id, nextState);
    session.state = nextState;
  }
}

async function clearMessageKeyboard(telegramChatId: number, messageId?: number) {
  if (!messageId) return;
  try {
    await telegram.editMessageReplyMarkup(telegramChatId, messageId, undefined);
  } catch {
    /* message may be gone */
  }
}

async function publishPickExplainerPrompt(ctx: GameCtx, session: GameSession, summary: string) {
  await clearMessageKeyboard(ctx.telegramChatId, session.state.gameMessageId);
  await clearMessageKeyboard(ctx.telegramChatId, session.state.pickMessageId);

  const prevExplainerId = session.state.lastExplainerId as number | undefined;
  const prevExplainerName = session.state.lastExplainerName as string | undefined;
  const repeatHint =
    prevExplainerId && prevExplainerName
      ? `\n\n${await lookupMemberTag(ctx.admin, ctx.chatId, prevExplainerId, { name: prevExplainerName })} только что загадывал — пусть другой.`
      : "";

  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    `${summary}${repeatHint}\n\nКто следующий? Первый жмёт «Загадать».`,
    { reply_markup: volunteerKeyboard(session.short_code) },
  );
  const pickMessageId = sent?.result?.message_id;
  if (pickMessageId) {
    await updateSessionState(ctx.admin, session.id, { ...session.state, pickMessageId });
    session.state.pickMessageId = pickMessageId;
  }
}

async function beginPickExplainer(ctx: GameCtx, session: GameSession, summary: string) {
  const nextState = buildPickExplainerState(session);
  await updateSessionState(ctx.admin, session.id, nextState);
  session.state = nextState;
  await publishPickExplainerPrompt(ctx, session, summary);
}

/** Atomically end the round on a correct guess — only the first matching message wins. */
async function claimCorrectGuess(
  ctx: GameCtx,
  session: GameSession,
  guesserId: number,
  guessText: string,
): Promise<
  | { ok: true; word: string; explainerId: number; explainerName?: string; session: GameSession }
  | { ok: false }
> {
  const { data: fresh, error: loadError } = await ctx.admin
    .from("game_sessions")
    .select("*")
    .eq("id", session.id)
    .maybeSingle();
  if (loadError) {
    console.error("crocodile guess load failed", loadError);
    return { ok: false };
  }
  if (!fresh || fresh.status !== "active") return { ok: false };

  const state = fresh.state as GameSession["state"];
  if (resolveCrocodilePhase(state) !== "playing") return { ok: false };
  if (!state.word || typeof state.word !== "string") return { ok: false };
  if (guesserId === state.explainerId) return { ok: false };
  if (!containsWord(guessText, state.word)) return { ok: false };

  const nextState = buildPickExplainerState(fresh as GameSession);
  const { data, error } = await ctx.admin
    .from("game_sessions")
    .update({ state: nextState })
    .eq("id", fresh.id)
    .eq("status", "active")
    .eq("updated_at", fresh.updated_at)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("crocodile guess claim failed", error);
    return { ok: false };
  }
  if (!data) return { ok: false };

  return {
    ok: true,
    word: state.word,
    explainerId: state.explainerId as number,
    explainerName: state.explainerName as string | undefined,
    session: data as GameSession,
  };
}

/** Atomically claim the next round — only one volunteer wins. */
async function claimVolunteerRound(
  ctx: GameCtx,
  shortCode: string,
  explainer: CrocodileVolunteer,
): Promise<"claimed" | "repeat" | "taken" | "gone"> {
  const fresh = await getSessionByShortCode(ctx.admin, shortCode);
  if (!fresh || fresh.status !== "active") return "gone";

  const phase = resolveCrocodilePhase(fresh.state);
  if (phase !== "pick_explainer") return "taken";
  if (fresh.state.lastExplainerId === explainer.id) return "repeat";

  const usedWords = (fresh.state.usedWords ?? []) as string[];
  const { word, category } = randomCrocodileWord(usedWords);
  const nextState = {
    ...fresh.state,
    phase: "playing" as CrocodilePhase,
    explainerId: explainer.id,
    explainerName: explainer.name,
    word,
    category,
    skippedWords: [],
    pickToken: undefined,
    explainerDmMessageId: undefined,
    deadlineAt: new Date(Date.now() + ROUND_MS).toISOString(),
    gameMessageId: undefined,
  };

  const { data, error } = await ctx.admin
    .from("game_sessions")
    .update({ state: nextState })
    .eq("id", fresh.id)
    .eq("status", "active")
    .eq("updated_at", fresh.updated_at)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("crocodile claim failed", error);
    return "taken";
  }
  return data ? "claimed" : "taken";
}

async function rollbackToPickExplainer(ctx: GameCtx, session: GameSession, explainerName: string) {
  const nextState = {
    ...session.state,
    phase: "pick_explainer" as CrocodilePhase,
    pickToken: genPickToken(),
    explainerId: undefined,
    explainerName: undefined,
    word: undefined,
    category: undefined,
    deadlineAt: undefined,
    skippedWords: undefined,
    gameMessageId: undefined,
    explainerDmMessageId: undefined,
  };
  await updateSessionState(ctx.admin, session.id, nextState);
  await telegram.sendMessage(
    ctx.telegramChatId,
    `Не смог выдать слово <b>${explainerName}</b> — жми «Загадать» ещё раз.`,
    { reply_markup: volunteerKeyboard(session.short_code) },
  );
}

async function notifyExplainerRound(ctx: GameCtx, session: GameSession, explainer: CrocodileVolunteer) {
  const fresh = await getSessionByShortCode(ctx.admin, session.short_code);
  if (!fresh || fresh.state.phase !== "playing" || fresh.state.explainerId !== explainer.id) {
    throw new Error("crocodile notify: session no longer matches explainer");
  }
  session.state = fresh.state;

  try {
    await clearMessageKeyboard(ctx.telegramChatId, session.state.pickMessageId);

    let dmSent = false;
    try {
      await publishExplainerWord(ctx, fresh, explainer.id);
      dmSent = true;
    } catch (e) {
      console.error("crocodile DM failed", e);
    }

    if (!dmSent) {
      const link = await buildDeepLink(`croc_${session.short_code}`);
      const explainerTag = await lookupMemberTag(ctx.admin, ctx.chatId, explainer.id, { first_name: explainer.name });
      await telegram.sendMessage(
        ctx.telegramChatId,
        `${explainerTag}, не смог написать тебе в личку 😅 ${link ? `Жми сюда и потом /start: ${link}` : "Напиши мне первым в личку /start."}`,
      );
    }

    const explainerTag = await lookupMemberTag(ctx.admin, ctx.chatId, explainer.id, { first_name: explainer.name });
    const sent: any = await telegram.sendMessage(
      ctx.telegramChatId,
      `🐊 ${explainerTag} загадывает слово. У чата ${ROUND_MS / 60000} минуты, чтобы угадать прямо в этом треде!`,
      { reply_markup: playingKeyboard(session.short_code) },
    );
    const gameMessageId = sent?.result?.message_id;
    if (gameMessageId) {
      const { data: afterDm } = await ctx.admin
        .from("game_sessions")
        .select("state")
        .eq("id", fresh.id)
        .maybeSingle();
      await updateSessionState(ctx.admin, fresh.id, {
        ...(afterDm?.state ?? fresh.state),
        gameMessageId,
      });
    }
  } catch (e) {
    console.error("crocodile notify failed", e);
    await rollbackToPickExplainer(ctx, fresh, explainer.name);
    throw e;
  }
}

async function claimSkipWord(
  ctx: GameCtx,
  session: GameSession,
  fromUserId: number,
): Promise<{ ok: true; session: GameSession } | { ok: false }> {
  const { data: fresh, error: loadError } = await ctx.admin
    .from("game_sessions")
    .select("*")
    .eq("id", session.id)
    .maybeSingle();
  if (loadError) {
    console.error("crocodile skip load failed", loadError);
    return { ok: false };
  }
  if (!fresh || fresh.status !== "active") return { ok: false };
  if (resolveCrocodilePhase(fresh.state) !== "playing") return { ok: false };
  if (fromUserId !== fresh.state.explainerId) return { ok: false };

  const usedWords = [
    ...(fresh.state.usedWords ?? []),
    ...(fresh.state.skippedWords ?? []),
    fresh.state.word,
  ].filter(Boolean);
  const { word, category } = randomCrocodileWord(usedWords);
  const skippedWords = [...(fresh.state.skippedWords ?? []), fresh.state.word];
  const nextState = {
    ...fresh.state,
    word,
    category,
    skippedWords,
  };

  const { data, error } = await ctx.admin
    .from("game_sessions")
    .update({ state: nextState })
    .eq("id", fresh.id)
    .eq("status", "active")
    .eq("updated_at", fresh.updated_at)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("crocodile skip claim failed", error);
    return { ok: false };
  }
  if (!data) return { ok: false };
  return { ok: true, session: data as GameSession };
}

async function skipCrocodileWord(
  ctx: GameCtx,
  session: GameSession,
  fromUserId: number,
  callbackQueryId?: string,
  dmMessageId?: number,
) {
  const claim = await claimSkipWord(ctx, session, fromUserId);
  if (!claim.ok) {
    if (callbackQueryId) {
      await telegram.answerCallbackQuery(callbackQueryId, "Сейчас нельзя сменить слово", true);
    }
    return;
  }

  await publishExplainerWord(ctx, claim.session, fromUserId, dmMessageId);
  if (callbackQueryId) {
    await telegram.answerCallbackQuery(callbackQueryId, "Вот другое слово 👇");
  }
}

export async function startCrocodile(ctx: GameCtx, invoker: { id: number; name: string }) {
  const existing = await getBlockingSession(ctx.admin, ctx.chatId, "crocodile");
  if (existing) return { alreadyActive: true as const };

  const { word, category } = randomCrocodileWord();
  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "crocodile",
    {
      phase: "playing",
      explainerId: invoker.id,
      explainerName: invoker.name,
      word,
      category,
      usedWords: [],
      deadlineAt: new Date(Date.now() + ROUND_MS).toISOString(),
    },
    invoker.id,
    "active",
  );

  let dmSent = false;
  try {
    await publishExplainerWord(ctx, session, invoker.id);
    dmSent = true;
  } catch (e) {
    console.error("crocodile DM failed", e);
  }

  if (!dmSent) {
    const link = await buildDeepLink(`croc_${session.short_code}`);
    const invokerTag = await lookupMemberTag(ctx.admin, ctx.chatId, invoker.id, { first_name: invoker.name });
    await telegram.sendMessage(
      ctx.telegramChatId,
      `${invokerTag}, не смог написать тебе в личку 😅 ${link ? `Жми сюда и потом /start: ${link}` : "Напиши мне первым в личку /start."}`,
    );
  }

  const invokerTag = await lookupMemberTag(ctx.admin, ctx.chatId, invoker.id, { first_name: invoker.name });
  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    `🐊 <b>Крокодил начался!</b>\n${invokerTag} загадывает слово. У чата ${ROUND_MS / 60000} минуты, чтобы угадать прямо в этом треде!`,
    { reply_markup: playingKeyboard(session.short_code) },
  );
  const gameMessageId = sent?.result?.message_id;
  if (gameMessageId) {
    await updateSessionState(ctx.admin, session.id, { ...session.state, gameMessageId });
  }
  return { session };
}

export async function resendCrocodileWord(
  admin: GameCtx["admin"],
  session: GameSession,
  telegramUserId: number,
) {
  const { data: fresh } = await admin
    .from("game_sessions")
    .select("*")
    .eq("id", session.id)
    .maybeSingle();
  if (
    !fresh ||
    resolveCrocodilePhase(fresh.state) !== "playing" ||
    fresh.state.explainerId !== telegramUserId
  ) {
    return;
  }
  const { data: chatRow } = await admin
    .from("chats")
    .select("telegram_chat_id")
    .eq("id", fresh.chat_id)
    .maybeSingle();
  if (!chatRow) return;

  const ctx: GameCtx = {
    admin,
    chatId: fresh.chat_id,
    telegramChatId: chatRow.telegram_chat_id,
    lang: "ru",
  };
  await publishExplainerWord(ctx, fresh as GameSession, telegramUserId);
}

export async function handleCrocodilePrivateMessage(
  admin: GameCtx["admin"],
  telegramUserId: number,
  text: string,
): Promise<boolean> {
  const cmd = text.trim().toLowerCase();
  if (cmd !== "/skip") return false;

  const { data: sessions } = await admin
    .from("game_sessions")
    .select("*, chats!inner(telegram_chat_id)")
    .eq("type", "crocodile")
    .eq("status", "active");

  for (const raw of sessions ?? []) {
    if (resolveCrocodilePhase(raw.state) !== "playing" || raw.state.explainerId !== telegramUserId) {
      continue;
    }
    const ctx: GameCtx = {
      admin,
      chatId: raw.chat_id,
      telegramChatId: (raw as any).chats.telegram_chat_id,
      lang: "ru",
    };
    await skipCrocodileWord(ctx, raw as GameSession, telegramUserId);
    return true;
  }

  await telegram.sendMessage(telegramUserId, "Сейчас ты нигде не загадываешь в Крокодиле 🐊");
  return true;
}

export async function handleCrocodileCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  callbackQueryId: string,
  fromUser: { id: number; name: string },
  dmMessageId?: number,
) {
  const fresh = (await getSessionByShortCode(ctx.admin, session.short_code)) ?? session;
  const phase = resolveCrocodilePhase(fresh.state);

  if (action === "volunteer") {
    if (phase === "playing") {
      await telegram.answerCallbackQuery(callbackQueryId, "Сейчас идёт раунд", true);
      return;
    }
    if (phase !== "pick_explainer") {
      await telegram.answerCallbackQuery(callbackQueryId, "Уже занято", true);
      return;
    }
    if (fresh.state.lastExplainerId === fromUser.id) {
      await telegram.answerCallbackQuery(callbackQueryId, "Ты только что загадывал — пусть другой 🙂", true);
      return;
    }

    await telegram.answerCallbackQuery(callbackQueryId);

    const result = await claimVolunteerRound(ctx, session.short_code, fromUser);
    if (result === "taken") {
      await telegram.sendMessage(ctx.telegramChatId, "Другой успел первым — жми «Загадать» на свежем сообщении.");
      return;
    }
    if (result === "gone") {
      await telegram.sendMessage(ctx.telegramChatId, "Игра уже закончилась.");
      return;
    }

    void clearMessageKeyboard(ctx.telegramChatId, fresh.state.pickMessageId);

    const notify = notifyExplainerRound(ctx, fresh, fromUser).catch((e) =>
      console.error("crocodile notify background failed", e),
    );
    if (ctx.waitUntil) ctx.waitUntil(notify);
    else await notify;
    return;
  }

  if (phase !== "playing") {
    await telegram.answerCallbackQuery(callbackQueryId, "Сейчас не идёт раунд", true);
    return;
  }

  if (action === "hint") {
    if (fromUser.id !== fresh.state.explainerId) {
      await telegram.answerCallbackQuery(callbackQueryId, "Подсказку даёт только загадывающий 😏", true);
      return;
    }
    await telegram.answerCallbackQuery(callbackQueryId, `Категория: ${fresh.state.category}`);
    await telegram.sendMessage(
      ctx.telegramChatId,
      `💡 Подсказка: слово из категории «<b>${fresh.state.category}</b>»`,
    );
    return;
  }
  if (action === "skip") {
    await skipCrocodileWord(ctx, fresh, fromUser.id, callbackQueryId, dmMessageId);
    return;
  }
  if (action === "surrender") {
    if (fromUser.id !== fresh.state.explainerId) {
      await telegram.answerCallbackQuery(callbackQueryId, "Сдаться может только загадывающий", true);
      return;
    }
    await telegram.answerCallbackQuery(callbackQueryId, "Сдался!");
    const explainerTag = await lookupMemberTag(ctx.admin, ctx.chatId, fresh.state.explainerId, {
      first_name: fresh.state.explainerName,
    });
    await beginPickExplainer(
      ctx,
      fresh,
      `🏳 ${explainerTag} сдался! Слово было «<b>${escapeHtml(String(fresh.state.word))}</b>».`,
    );
  }
}

export async function handleCrocodileMessage(
  ctx: GameCtx,
  session: GameSession,
  message: {
    from?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
    text?: string;
  },
): Promise<boolean> {
  if (!message.text?.trim() || !message.from?.id) return false;

  const claim = await claimCorrectGuess(ctx, session, message.from.id, message.text);
  if (!claim.ok) return false;

  const guesserTag = await lookupMemberTag(ctx.admin, ctx.chatId, message.from.id, message.from);
  const explainerTag = await lookupMemberTag(ctx.admin, ctx.chatId, claim.explainerId, {
    first_name: claim.explainerName,
  });
  const safeWord = escapeHtml(claim.word);

  await awardCoins(ctx.admin, ctx.chatId, message.from.id, 15, "game_win", { game: "crocodile" });
  await awardCoins(ctx.admin, ctx.chatId, claim.explainerId, 5, "game_win", {
    game: "crocodile_explainer",
  });

  try {
    await publishPickExplainerPrompt(
      ctx,
      claim.session,
      `🎉 ${guesserTag} угадал! Слово было «<b>${safeWord}</b>». +15 БешКоинов угадавшему, +5 ${explainerTag}.`,
    );
  } catch (e) {
    console.error("crocodile guess announce failed", e);
    await telegram.sendMessage(
      ctx.telegramChatId,
      `🎉 ${guesserTag} угадал! Слово было «${safeWord}». +15 БешКоинов угадавшему, +5 объяснявшему.`,
      { reply_markup: volunteerKeyboard(claim.session.short_code) },
    );
  }
  return true;
}

export async function tickCrocodile(ctx: GameCtx, session: GameSession) {
  const phase = resolveCrocodilePhase(session.state);
  if (phase !== "playing") return;
  if (new Date(session.state.deadlineAt).getTime() > Date.now()) return;

  await beginPickExplainer(
    ctx,
    session,
    `⏰ Время вышло! Слово было «<b>${session.state.word}</b>». Никто не угадал, бывает.`,
  );
}

export async function getCrocodileGuessTop(
  admin: SupabaseClient,
  chatId: string,
  limit = 10,
): Promise<
  Array<{
    telegram_user_id: number;
    username: string | null;
    display_name: string | null;
    guesses: number;
  }>
> {
  const { data: rows } = await admin
    .from("economy_ledger")
    .select("telegram_user_id")
    .eq("chat_id", chatId)
    .eq("reason", "game_win")
    .contains("meta", { game: "crocodile" });

  const counts = new Map<number, number>();
  for (const row of rows ?? []) {
    counts.set(row.telegram_user_id, (counts.get(row.telegram_user_id) ?? 0) + 1);
  }

  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  if (sorted.length === 0) return [];

  const ids = sorted.map(([id]) => id);
  const { data: members } = await admin
    .from("chat_members")
    .select("telegram_user_id, username, display_name")
    .eq("chat_id", chatId)
    .in("telegram_user_id", ids);

  const memberMap = new Map((members ?? []).map((m) => [m.telegram_user_id, m]));

  return sorted.map(([telegram_user_id, guesses]) => {
    const m = memberMap.get(telegram_user_id);
    return {
      telegram_user_id,
      username: m?.username ?? null,
      display_name: m?.display_name ?? null,
      guesses,
    };
  });
}

function guessCountLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "слово";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "слова";
  return "слов";
}

export function formatCrocodileTopMessage(
  top: Array<{
    telegram_user_id: number;
    username: string | null;
    display_name: string | null;
    guesses: number;
  }>,
): string {
  if (!top.length) {
    return "🐊 Пока никто не угадывал слова в крокодиле — самое время начать /crocodile!";
  }
  const medals = ["🥇", "🥈", "🥉"];
  const lines = top.map((m, i) => {
    const prefix = medals[i] ?? `${i + 1}.`;
    return `${prefix} ${chatMemberTag(m)} — ${m.guesses} ${guessCountLabel(m.guesses)}`;
  });
  return `🐊 <b>Топ отгадавших в крокодиле</b>\n${lines.join("\n")}`;
}
