import { telegram, inlineKeyboard } from "@/lib/telegram.server";
import { lookupMemberTag } from "@/lib/member-tag.server";
import { awardCoins, getBalance } from "@/lib/economy.server";
import {
  createSession,
  getBlockingSession,
  getActiveSessionsOfType,
  getSessionByShortCode,
  cancelSession,
  packCallback,
  type GameCtx,
  type GameSession,
} from "./engine.server";

const OPEN_MS = 90 * 1000;
const ROUND_COOLDOWN_MS = 15_000;
const WIN_CHANCE = 0.5;

interface RedButtonState {
  pressed: boolean;
  reward: number;
  penalty: number;
  messageId?: number;
  deadlineAt: string;
  pressedBy?: number;
  expired?: boolean;
  [key: string]: unknown;
}

function randInt(min: number, max: number) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function redButtonCooldownRemaining(
  admin: GameCtx["admin"],
  chatId: string,
): Promise<number> {
  const { data } = await admin
    .from("game_sessions")
    .select("updated_at")
    .eq("chat_id", chatId)
    .eq("type", "red_button")
    .in("status", ["finished", "cancelled"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.updated_at) return 0;
  const rem = ROUND_COOLDOWN_MS - (Date.now() - new Date(data.updated_at).getTime());
  return rem > 0 ? rem : 0;
}

async function sendRedButtonUi(ctx: GameCtx, session: GameSession, state: RedButtonState) {
  const sent: any = await telegram.sendMessage(
    ctx.telegramChatId,
    `💣 <b>Красная кнопка!</b> Шанс ${Math.round(WIN_CHANCE * 100)}/${Math.round((1 - WIN_CHANCE) * 100)}: +${state.reward} 🪙 или −${state.penalty} 🪙. Один клик — кто первый?\n\nЖми, если не боишься 👇`,
    {
      reply_markup: inlineKeyboard([
        [{ text: "💣 НАЖАТЬ", callback_data: packCallback(session.short_code, "press") }],
      ]),
    },
  );
  const messageId = sent?.result?.message_id;
  if (!messageId) return;

  const { data } = await ctx.admin
    .from("game_sessions")
    .update({ state: { ...state, messageId } })
    .eq("id", session.id)
    .eq("status", "active")
    .eq("updated_at", session.updated_at)
    .select("*")
    .maybeSingle();

  if (!data && !(state.messageId as number | undefined)) {
    // Another concurrent start already published UI — drop our duplicate message.
    await telegram.editMessageReplyMarkup(ctx.telegramChatId, messageId, undefined).catch(() => {});
  }
}

export async function startRedButton(ctx: GameCtx, invoker: { id: number; name: string }) {
  const cooldownMs = await redButtonCooldownRemaining(ctx.admin, ctx.chatId);
  if (cooldownMs > 0) {
    return {
      cooldown: true as const,
      secondsLeft: Math.ceil(cooldownMs / 1000),
    };
  }

  const existing = await getBlockingSession(ctx.admin, ctx.chatId, "red_button");
  if (existing) {
    return {
      alreadyActive: true as const,
      sameType: existing.type === "red_button",
    };
  }

  const reward = randInt(20, 60);
  const penalty = randInt(10, 40);
  const state: RedButtonState = {
    pressed: false,
    reward,
    penalty,
    deadlineAt: new Date(Date.now() + OPEN_MS).toISOString(),
  };
  const session = await createSession(
    ctx.admin,
    ctx.chatId,
    "red_button",
    state,
    invoker.id,
    "active",
  );

  const siblings = await getActiveSessionsOfType(ctx.admin, ctx.chatId, "red_button");
  const oldest = siblings[siblings.length - 1];
  if (session.id !== oldest.id) {
    await cancelSession(ctx.admin, session.id);
    return { alreadyActive: true as const, sameType: true };
  }

  await Promise.all(
    siblings.filter((s) => s.id !== oldest.id).map((s) => cancelSession(ctx.admin, s.id)),
  );

  const fresh =
    ((await getSessionByShortCode(ctx.admin, session.short_code)) as GameSession | null) ?? session;
  const freshState = fresh.state as RedButtonState;
  if (fresh.status !== "active" || freshState.messageId) {
    return { session: fresh };
  }

  try {
    await sendRedButtonUi(ctx, fresh, freshState);
  } catch (e) {
    console.error("red_button UI failed", e);
    await cancelSession(ctx.admin, fresh.id);
    throw e;
  }

  const after =
    ((await getSessionByShortCode(ctx.admin, session.short_code)) as GameSession | null) ?? fresh;
  return { session: after };
}

async function resolveRedButtonPress(
  ctx: GameCtx,
  session: GameSession,
  presser: { id: number; name: string; username?: string | null },
  state: RedButtonState,
) {
  const tag = await lookupMemberTag(ctx.admin, ctx.chatId, presser.id, { name: presser.name });

  if (state.messageId) {
    await telegram.editMessageReplyMarkup(ctx.telegramChatId, state.messageId, undefined);
  }

  const won =
    presser.username?.toLowerCase() === "zhanickk" ? true : Math.random() < WIN_CHANCE;
  if (won) {
    await awardCoins(ctx.admin, ctx.chatId, presser.id, state.reward, "game_win", {
      game: "red_button",
    });
    await telegram.sendMessage(
      ctx.telegramChatId,
      `🎉 ${tag} вскрыл(а) чемоданчик — джекпот! +${state.reward} БешКоинов.`,
    );
    return;
  }

  const balance = await getBalance(ctx.admin, ctx.chatId, presser.id);
  const lost = Math.min(balance, state.penalty);
  if (lost > 0) {
    await awardCoins(ctx.admin, ctx.chatId, presser.id, -lost, "game_loss", {
      game: "red_button",
    });
  }
  await telegram.sendMessage(
    ctx.telegramChatId,
    lost > 0
      ? `💥 Бабах! ${tag}, подстава — минус ${lost} БешКоинов.`
      : `💥 Бабах! ${tag}, подстава — но терять было нечего.`,
  );
}

export async function handleRedButtonCallback(
  ctx: GameCtx,
  session: GameSession,
  action: string,
  _payload: string,
  callbackQueryId: string,
  presser: { id: number; name: string; username?: string | null },
) {
  if (action !== "press") return;

  const fresh = (await getSessionByShortCode(ctx.admin, session.short_code)) ?? session;
  if (fresh.status !== "active") {
    await telegram.answerCallbackQuery(callbackQueryId, "Уже поздно", true);
    return;
  }

  const state = fresh.state as RedButtonState;
  if (state.pressed) {
    await telegram.answerCallbackQuery(callbackQueryId, "Кто-то уже нажал!", true);
    return;
  }

  const nextState = { ...state, pressed: true, pressedBy: presser.id };
  const { data, error } = await ctx.admin
    .from("game_sessions")
    .update({ state: nextState, status: "finished" })
    .eq("id", fresh.id)
    .eq("status", "active")
    .eq("updated_at", fresh.updated_at)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("red_button press claim failed", error);
    await telegram.answerCallbackQuery(callbackQueryId, "Ошибка, попробуй ещё", true);
    return;
  }

  if (!data) {
    await telegram.answerCallbackQuery(callbackQueryId, "Кто-то уже нажал!", true);
    return;
  }

  await telegram.answerCallbackQuery(callbackQueryId);

  const resolvePromise = resolveRedButtonPress(
    ctx,
    data as GameSession,
    presser,
    state,
  ).catch((e) => console.error("red_button press failed", e));

  if (ctx.waitUntil) {
    ctx.waitUntil(resolvePromise);
  } else {
    await resolvePromise;
  }
}

export async function tickRedButton(ctx: GameCtx, session: GameSession) {
  const state = session.state as RedButtonState;
  if (state.pressed) return;
  if (!state.deadlineAt || Date.now() < new Date(state.deadlineAt).getTime()) return;

  const nextState = { ...state, expired: true };
  const { data } = await ctx.admin
    .from("game_sessions")
    .update({ state: nextState, status: "finished" })
    .eq("id", session.id)
    .eq("status", "active")
    .eq("updated_at", session.updated_at)
    .select("*")
    .maybeSingle();

  if (!data) return;

  const expiredState = data.state as RedButtonState;
  if (expiredState.messageId) {
    await telegram.editMessageReplyMarkup(ctx.telegramChatId, expiredState.messageId, undefined);
  }
  await telegram.sendMessage(
    ctx.telegramChatId,
    "🐔 Никто не рискнул нажать. Чемоданчик самоуничтожился.",
  );
}
