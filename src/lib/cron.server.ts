import { createHash, timingSafeEqual } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tickCrocodile } from "@/lib/games/crocodile.server";
import { tickTaboo, tickTabooSession } from "@/lib/games/taboo.server";
import { tickCringe } from "@/lib/games/cringe.server";
import { tickTwoTruths } from "@/lib/games/two_truths.server";
import { tickMemeOfDay } from "@/lib/games/meme_of_day.server";
import { tickMafia, tickMafiaSession } from "@/lib/games/mafia.server";
import { tickRedButton } from "@/lib/games/red_button.server";
import { tickExcuseDuel } from "@/lib/games/excuse_duel.server";
import { tickQuizDuel } from "@/lib/games/quiz_duel.server";
import { tickAiesecQuiz } from "@/lib/games/aiesec_quiz.server";
import { tickShipping, runShippingStartTick } from "@/lib/shipping.server";
import { runEngagementTick, tryOrganicChimeIn } from "@/lib/engagement.server";
import { runCheckinTick } from "@/lib/checkin.server";
import { postTumbaDigest, runTumbaAccumulationTick } from "@/lib/tumba.server";
import type { GameCtx, GameSession } from "@/lib/games/engine.server";
import { isSessionDue } from "@/lib/timers.server";

function deriveTickSecret(): string {
  const tgKey = process.env.TELEGRAM_API_KEY ?? "";
  return createHash("sha256").update(`cron-tick:${tgKey}`).digest("base64url");
}

export function verifyTickSecret(headerValue: string | null): boolean {
  if (!headerValue) return false;
  const expected = deriveTickSecret();
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Advances timed mini-game phases (crocodile/cringe/two_truths/meme_of_day/red_button/duels). Taboo & mafia have dedicated ticks. */
export async function runGameTick(admin: SupabaseClient) {
  const { data: sessions } = await admin
    .from("game_sessions")
    .select("*, chats!inner(id, telegram_chat_id)")
    .in("status", ["waiting", "active"])
    .not("type", "eq", "mafia")
    .not("type", "eq", "taboo");

  for (const session of sessions ?? []) {
    if (!isSessionDue(session.state)) continue;
    const ctx: GameCtx = {
      admin,
      chatId: session.chat_id,
      telegramChatId: (session as any).chats.telegram_chat_id,
      lang: "ru",
    };
    const s = session as unknown as GameSession;
    try {
      if (session.type === "crocodile") await tickCrocodile(ctx, s);
      else if (session.type === "cringe") await tickCringe(ctx, s);
      else if (session.type === "aiesec_quiz") await tickAiesecQuiz(ctx, s);
      else if (session.type === "two_truths") await tickTwoTruths(ctx, s);
      else if (session.type === "meme_of_day") await tickMemeOfDay(ctx, s);
      else if (session.type === "red_button") await tickRedButton(ctx, s);
      else if (session.type === "excuse_duel") await tickExcuseDuel(ctx, s);
      else if (session.type === "quiz_duel") await tickQuizDuel(ctx, s);
    } catch (e) {
      console.error(`game-tick failed for session ${session.id} (${session.type})`, e);
    }
  }

  try {
    await tickMafia(admin);
  } catch (e) {
    console.error("mafia tick failed", e);
  }
  try {
    await tickTaboo(admin);
  } catch (e) {
    console.error("taboo tick failed", e);
  }
}

export async function runFastTicks(admin: SupabaseClient) {
  await Promise.all([
    runEngagementTick(admin).catch((e) => console.error("engagement tick failed", e)),
    runGameTick(admin).catch((e) => console.error("game tick failed", e)),
    tickShipping(admin).catch((e) => console.error("shipping tick failed", e)),
    runShippingStartTick(admin).catch((e) => console.error("shipping start tick failed", e)),
    runCheckinTick(admin).catch((e) => console.error("checkin tick failed", e)),
    runTumbaAccumulationTick(admin).catch((e) => console.error("tumba accumulation tick failed", e)),
  ]);
}

export async function runTumbaDigestTick(admin: SupabaseClient) {
  const { data: chats } = await admin
    .from("chats")
    .select("id, telegram_chat_id")
    .eq("is_active", true);
  for (const chat of chats ?? []) {
    try {
      await postTumbaDigest(admin, chat.id, chat.telegram_chat_id, "ama");
    } catch (e) {
      console.error("tumba ama digest failed", chat.telegram_chat_id, e);
    }
  }
}

/** Run due timers for one chat (piggyback on webhook — reduces cron lag). */
export async function runDueTicksForChat(admin: SupabaseClient, chatId: string) {
  const { data: chatRow } = await admin
    .from("chats")
    .select("telegram_chat_id")
    .eq("id", chatId)
    .maybeSingle();
  if (!chatRow) return;

  const { data: sessions } = await admin
    .from("game_sessions")
    .select("*")
    .eq("chat_id", chatId)
    .in("status", ["waiting", "active"]);

  const ctx: GameCtx = {
    admin,
    chatId,
    telegramChatId: chatRow.telegram_chat_id,
    lang: "ru",
  };

  for (const session of sessions ?? []) {
    if (!isSessionDue(session.state)) continue;
    const s = session as unknown as GameSession;
    try {
      if (session.type === "crocodile") await tickCrocodile(ctx, s);
      else if (session.type === "cringe") await tickCringe(ctx, s);
      else if (session.type === "aiesec_quiz") await tickAiesecQuiz(ctx, s);
      else if (session.type === "two_truths") await tickTwoTruths(ctx, s);
      else if (session.type === "meme_of_day") await tickMemeOfDay(ctx, s);
      else if (session.type === "red_button") await tickRedButton(ctx, s);
      else if (session.type === "excuse_duel") await tickExcuseDuel(ctx, s);
      else if (session.type === "quiz_duel") await tickQuizDuel(ctx, s);
      else if (session.type === "mafia") {
        const full = { ...session, chats: { telegram_chat_id: chatRow.telegram_chat_id } };
        await tickMafiaSession(admin, full);
      } else if (session.type === "taboo") {
        const full = { ...session, chats: { telegram_chat_id: chatRow.telegram_chat_id } };
        await tickTabooSession(admin, full);
      }
    } catch (e) {
      console.error(`due tick failed ${session.id} (${session.type})`, e);
    }
  }
}
