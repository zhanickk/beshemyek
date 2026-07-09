import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import type { Lang } from "@/lib/telegram.server";

export type GameType =
  | "crocodile"
  | "cringe"
  | "taboo"
  | "truth_or_dare"
  | "mafia"
  | "aiesec_quiz"
  | "two_truths"
  | "meme_of_day"
  | "totalizator"
  | "archetype_quiz"
  | "red_button"
  | "excuse_duel"
  | "quiz_duel";

export type GameStatus = "waiting" | "active" | "finished" | "cancelled";

export interface GameSession {
  id: string;
  chat_id: string;
  type: GameType;
  short_code: string;
  status: GameStatus;
  state: any;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface GamePlayer {
  id: number;
  name: string;
  [key: string]: unknown;
}

/** Compact context passed to every game handler. */
export interface GameCtx {
  admin: SupabaseClient;
  chatId: string; // internal uuid (chats.id)
  telegramChatId: number;
  lang: Lang;
  waitUntil?: (promise: Promise<unknown>) => void;
}

const CODE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function genShortCode(len = 6): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return out;
}

/** Packs callback data as `g:<shortCode>:<action>:<payload>`, respecting Telegram's 64-byte limit. */
export function packCallback(shortCode: string, action: string, payload = ""): string {
  const data = `g:${shortCode}:${action}:${payload}`;
  if (data.length > 64) {
    console.error(`callback_data too long (${data.length}b): ${data}`);
    return data.slice(0, 64);
  }
  return data;
}

export function parseCallback(
  data: string,
): { shortCode: string; action: string; payload: string } | null {
  if (!data.startsWith("g:")) return null;
  const [, shortCode, action, ...rest] = data.split(":");
  if (!shortCode || !action) return null;
  return { shortCode, action, payload: rest.join(":") };
}

export async function createSession(
  admin: SupabaseClient,
  chatId: string,
  type: GameType,
  initialState: Record<string, unknown>,
  createdBy?: number | null,
  status: GameStatus = "waiting",
): Promise<GameSession> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const short_code = genShortCode();
    const { data, error } = await admin
      .from("game_sessions")
      .insert({
        chat_id: chatId,
        type,
        short_code,
        status,
        state: initialState,
        created_by: createdBy ?? null,
      })
      .select("*")
      .single();
    if (!error) return data as GameSession;
    if (!`${error.message}`.includes("duplicate key")) throw error;
  }
  throw new Error("Failed to allocate a unique game short_code after 5 attempts");
}

export async function getActiveSession(
  admin: SupabaseClient,
  chatId: string,
  type?: GameType,
): Promise<GameSession | null> {
  let q = admin
    .from("game_sessions")
    .select("*")
    .eq("chat_id", chatId)
    .in("status", ["waiting", "active"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (type) q = q.eq("type", type);
  const { data } = await q.maybeSingle();
  return (data as GameSession | null) ?? null;
}

export async function getActiveSessions(
  admin: SupabaseClient,
  chatId: string,
): Promise<GameSession[]> {
  const { data } = await admin
    .from("game_sessions")
    .select("*")
    .eq("chat_id", chatId)
    .in("status", ["waiting", "active"])
    .order("created_at", { ascending: false });
  return (data as GameSession[]) ?? [];
}

export async function allowConcurrentGames(
  admin: SupabaseClient,
  chatId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("bot_settings")
    .select("allow_concurrent_games")
    .eq("chat_id", chatId)
    .maybeSingle();
  return data?.allow_concurrent_games ?? false;
}

export async function allowMemberEndgame(
  admin: SupabaseClient,
  chatId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("bot_settings")
    .select("allow_member_endgame")
    .eq("chat_id", chatId)
    .maybeSingle();
  return data?.allow_member_endgame ?? false;
}

/** Returns an active session that blocks starting `forType` (respects dashboard toggle). */
export async function getBlockingSession(
  admin: SupabaseClient,
  chatId: string,
  forType: GameType,
): Promise<GameSession | null> {
  if (await allowConcurrentGames(admin, chatId)) {
    return getActiveSession(admin, chatId, forType);
  }
  return getActiveSession(admin, chatId);
}

export async function getActiveSessionsOfType(
  admin: SupabaseClient,
  chatId: string,
  type: GameType,
): Promise<GameSession[]> {
  const { data } = await admin
    .from("game_sessions")
    .select("*")
    .eq("chat_id", chatId)
    .eq("type", type)
    .in("status", ["waiting", "active"])
    .order("created_at", { ascending: false });
  return (data as GameSession[]) ?? [];
}

export async function getSessionByShortCode(
  admin: SupabaseClient,
  shortCode: string,
): Promise<GameSession | null> {
  const { data } = await admin
    .from("game_sessions")
    .select("*")
    .eq("short_code", shortCode)
    .maybeSingle();
  return (data as GameSession | null) ?? null;
}

export async function getAllDueSessions(
  admin: SupabaseClient,
  type: GameType,
): Promise<GameSession[]> {
  const { data } = await admin
    .from("game_sessions")
    .select("*")
    .eq("type", type)
    .eq("status", "active");
  return (data as GameSession[]) ?? [];
}

export async function updateSessionState(
  admin: SupabaseClient,
  id: string,
  state: Record<string, unknown>,
  status?: GameStatus,
): Promise<void> {
  const patch: Record<string, unknown> = { state };
  if (status) patch.status = status;
  const { error } = await admin.from("game_sessions").update(patch).eq("id", id);
  if (error) throw error;
}

export async function finishSession(
  admin: SupabaseClient,
  id: string,
  state?: Record<string, unknown>,
) {
  const patch: Record<string, unknown> = { status: "finished" };
  if (state) patch.state = state;
  await admin.from("game_sessions").update(patch).eq("id", id);
}

export async function cancelSession(admin: SupabaseClient, id: string) {
  await admin.from("game_sessions").update({ status: "cancelled" }).eq("id", id);
}

export const GAME_LABELS: Record<GameType, string> = {
  crocodile: "Крокодил",
  cringe: "Кто этот Кринж / Кто это сказал",
  taboo: "Табу",
  truth_or_dare: "Правда или действие",
  mafia: "Мафия",
  aiesec_quiz: "AIESEC квиз",
  two_truths: "Два правды и одна ложь",
  meme_of_day: "Мем дня",
  totalizator: "Тотализатор",
  archetype_quiz: "Архетип-тест",
  red_button: "Красная кнопка",
  excuse_duel: "Дуэль отмазок",
  quiz_duel: "Квиз-дуэль 1×1",
};
