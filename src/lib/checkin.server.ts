import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText } from "ai";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";
import { telegram, inlineKeyboard } from "@/lib/telegram.server";
import { isFeatureEnabled } from "@/lib/features.server";
import { buildChatStyleBlock } from "@/lib/chat-style.server";
import { truncateBtn } from "@/lib/btn-label.server";

const CHECKIN_RESPONSE_MS = 20_000;
const CHECKIN_INTERVAL_MS = 6 * 3600 * 1000;
const CHECKIN_TARGET_STALE_MS = 30 * 60 * 1000;
const CHECKIN_MAX_PARTICIPANTS = 10;

type WaitUntilFn = (p: Promise<unknown>) => void;

export interface CheckinSession {
  id: string;
  chat_id: string;
  status: string;
  question: string;
  option_a: string;
  option_b: string;
  target_user_id: number;
  tagged_user_ids: number[];
  answered_user_ids: number[];
  relay_mode: string;
  pending_choice?: string | null;
  prompt_message_id?: number | null;
  initiator_user_id?: number | null;
  relay_from_user_id?: number | null;
  target_tagged_at?: string | null;
  created_at?: string;
}

type MemberRow = {
  telegram_user_id: number;
  username: string | null;
  display_name: string | null;
};

function memberTag(m: { username: string | null; display_name: string | null; telegram_user_id: number }) {
  return m.username ? `@${m.username}` : m.display_name || `#${m.telegram_user_id}`;
}

function formatCheckinPrompt(
  question: string,
  a: string,
  b: string,
  tag: string,
): string {
  return (
    `🧠 <b>Чекин!</b> ${question}\n\n` +
    `🅰️ ${a}\n` +
    `🅱️ ${b}\n\n` +
    `${tag}, жми кнопку ниже или напиши <b>А</b>/<b>Б</b> и коротко почему.`
  );
}

export function buildCheckinKeyboard(sessionId: string, optionA: string, optionB: string) {
  return inlineKeyboard([
    [
      {
        text: truncateBtn(`🅰️ ${optionA}`),
        callback_data: `checkin:${sessionId}:a`,
      },
      {
        text: truncateBtn(`🅱️ ${optionB}`),
        callback_data: `checkin:${sessionId}:b`,
      },
    ],
  ]);
}

async function generateCheckinQuestion(): Promise<{ question: string; a: string; b: string }> {
  const fallback = {
    question: "ты бы выбрал:",
    a: "вечный LCM по вторникам",
    b: "никогда больше не видеть свой джейдишку",
  };
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return fallback;
  try {
    const provider = createDeepSeekProvider(key);
    const { text } = await generateText({
      model: provider(getDeepSeekModel()),
      system: `Придумай креативный чекин «А или Б» для треш-чата студентов/AIESEC. Не банальность (не кошки/собаки). Привязка к студенчеству, локалке, движу — с изюминкой. ${buildChatStyleBlock()}\nВерни СТРОГО JSON: {"question": string, "a": string, "b": string}. Коротко, на русском.`,
      prompt: "Сгенерируй свежий чекин А/Б, оригинальный.",
    });
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    if (parsed.question && parsed.a && parsed.b) {
      return { question: String(parsed.question), a: String(parsed.a), b: String(parsed.b) };
    }
  } catch (e) {
    console.error("generateCheckinQuestion failed", e);
  }
  return fallback;
}

/** Picks next member: longest since last tagged, prefers quieter members in top pool. */
export async function pickCheckinTarget(
  admin: SupabaseClient,
  chatId: string,
  excludeIds: number[] = [],
): Promise<MemberRow | null> {
  const { data } = await admin
    .from("chat_members")
    .select("telegram_user_id, username, display_name, last_checkin_tagged_at, last_active_at")
    .eq("chat_id", chatId)
    .order("last_checkin_tagged_at", { ascending: true, nullsFirst: true })
    .limit(30);
  const pool = (data ?? []).filter((m) => !excludeIds.includes(m.telegram_user_id));
  if (pool.length === 0) return null;
  const candidates = pool.slice(0, Math.min(8, pool.length));
  const weights = candidates.map((m, i) => {
    const quietBonus = m.last_active_at
      ? Math.min(3, (Date.now() - new Date(m.last_active_at).getTime()) / 3600000 / 12)
      : 2;
    return 1 / (i + 1) + quietBonus * 0.3;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }
  return candidates[0];
}

async function getMember(
  admin: SupabaseClient,
  chatId: string,
  userId: number,
): Promise<MemberRow | null> {
  const { data } = await admin
    .from("chat_members")
    .select("telegram_user_id, username, display_name")
    .eq("chat_id", chatId)
    .eq("telegram_user_id", userId)
    .maybeSingle();
  return (data as MemberRow | null) ?? null;
}

export async function getActiveCheckin(
  admin: SupabaseClient,
  chatId: string,
): Promise<CheckinSession | null> {
  const { data } = await admin
    .from("checkin_sessions")
    .select("*")
    .eq("chat_id", chatId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as CheckinSession | null) ?? null;
}

function effectiveTaggedAt(session: CheckinSession): number {
  const raw = session.target_tagged_at ?? session.updated_at ?? session.created_at;
  return raw ? new Date(raw).getTime() : 0;
}

export function isCheckinSessionStale(session: CheckinSession, now = Date.now()): boolean {
  const created = session.created_at ? new Date(session.created_at).getTime() : 0;
  if (created > 0 && now - created >= CHECKIN_INTERVAL_MS) return true;
  const taggedAt = effectiveTaggedAt(session);
  return taggedAt > 0 && now - taggedAt >= CHECKIN_TARGET_STALE_MS;
}

function isCheckinResponseDue(session: CheckinSession, now = Date.now()): boolean {
  const taggedAt = effectiveTaggedAt(session);
  return taggedAt > 0 && now >= taggedAt + CHECKIN_RESPONSE_MS;
}

function nextRelayFrom(session: CheckinSession, revertedToUserId: number): number | null {
  const answered = session.answered_user_ids ?? [];
  const idx = answered.indexOf(revertedToUserId);
  if (idx > 0) return answered[idx - 1];
  return session.initiator_user_id ?? null;
}

export async function expireStaleCheckinSessions(
  admin: SupabaseClient,
  chatId?: string,
): Promise<number> {
  let query = admin
    .from("checkin_sessions")
    .select("*, chats!inner(telegram_chat_id)")
    .eq("status", "active");
  if (chatId) query = query.eq("chat_id", chatId);

  const { data } = await query;
  let closed = 0;
  for (const row of data ?? []) {
    const session = row as CheckinSession;
    if (!isCheckinSessionStale(session)) continue;
    await admin.from("checkin_sessions").update({ status: "finished" }).eq("id", session.id);
    try {
      await telegram.sendMessage(
        (row as any).chats.telegram_chat_id as number,
        "⏱ чекин завис — закрываем. Запусти новый через /checkin или подожди авто-чекин 🧠",
      );
    } catch (e) {
      console.error(`checkin stale close notify failed for ${session.id}`, e);
    }
    closed++;
  }
  return closed;
}

function scheduleCheckinDeadline(
  admin: SupabaseClient,
  sessionId: string,
  telegramChatId: number,
  waitUntil?: WaitUntilFn,
) {
  const work = (async () => {
    await new Promise((r) => setTimeout(r, CHECKIN_RESPONSE_MS + 250));
    await processCheckinTimeout(admin, sessionId, telegramChatId);
  })().catch((e) => console.error("checkin deadline failed", e));
  if (waitUntil) waitUntil(work);
}

export async function processCheckinTimeout(
  admin: SupabaseClient,
  sessionId: string,
  telegramChatId: number,
): Promise<void> {
  const { data: sessionRow } = await admin
    .from("checkin_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("status", "active")
    .maybeSingle();
  const session = sessionRow as CheckinSession | null;
  if (!session || !isCheckinResponseDue(session)) return;

  const fallback = session.relay_from_user_id;
  if (!fallback || fallback === session.target_user_id) {
    await admin.from("checkin_sessions").update({ status: "finished" }).eq("id", session.id);
    await telegram.sendMessage(telegramChatId, "⏱ никто не ответил на чекин — закрываем 🧠");
    return;
  }

  const failedMember = await getMember(admin, session.chat_id, session.target_user_id);
  const failedTag = failedMember ? memberTag(failedMember) : `#${session.target_user_id}`;

  const answered = [...(session.answered_user_ids ?? [])];
  const newAnswered = answered.filter((id) => id !== fallback);
  const newRelayFrom = nextRelayFrom(session, fallback);

  await admin
    .from("checkin_sessions")
    .update({
      target_user_id: fallback,
      answered_user_ids: newAnswered,
      relay_from_user_id: newRelayFrom,
      target_tagged_at: new Date().toISOString(),
      prompt_message_id: null,
    })
    .eq("id", session.id);

  const targetMember = await getMember(admin, session.chat_id, fallback);
  const targetTag = targetMember ? memberTag(targetMember) : `#${fallback}`;

  const updated: CheckinSession = {
    ...session,
    target_user_id: fallback,
    answered_user_ids: newAnswered,
    relay_from_user_id: newRelayFrom,
    target_tagged_at: new Date().toISOString(),
  };

  await sendCheckinPrompt(
    admin,
    updated,
    telegramChatId,
    targetTag,
    `⏱ ${failedTag} не успел(а) за 20 сек — снова твоя очередь!`,
  );
  scheduleCheckinDeadline(admin, session.id, telegramChatId);
}

export async function tickCheckinTimeouts(admin: SupabaseClient, chatId?: string) {
  await expireStaleCheckinSessions(admin, chatId);

  let query = admin
    .from("checkin_sessions")
    .select("id, chat_id, target_tagged_at, updated_at, created_at, chats!inner(telegram_chat_id)")
    .eq("status", "active");

  if (chatId) query = query.eq("chat_id", chatId);

  const { data: active } = await query;
  const now = Date.now();
  for (const row of active ?? []) {
    const session = row as CheckinSession;
    if (!isCheckinResponseDue(session, now)) continue;
    try {
      await processCheckinTimeout(
        admin,
        row.id,
        (row as any).chats.telegram_chat_id as number,
      );
    } catch (e) {
      console.error(`checkin timeout failed for session ${row.id}`, e);
    }
  }
}

async function sendCheckinPrompt(
  admin: SupabaseClient,
  session: CheckinSession,
  telegramChatId: number,
  tag: string,
  prefix = "",
) {
  const body =
    (prefix ? `${prefix}\n\n` : "") +
    formatCheckinPrompt(session.question, session.option_a, session.option_b, tag);
  const sent: any = await telegram.sendMessage(telegramChatId, body, {
    reply_markup: buildCheckinKeyboard(session.id, session.option_a, session.option_b),
  });
  const messageId = sent?.result?.message_id;
  if (messageId) {
    await admin.from("checkin_sessions").update({ prompt_message_id: messageId }).eq("id", session.id);
  }
}

export async function startCheckin(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  opts?: { initiatorUserId?: number; waitUntil?: WaitUntilFn },
): Promise<{ ok: true } | { noMembers: true } | { alreadyActive: true }> {
  const existing = await getActiveCheckin(admin, chatId);
  if (existing) {
    if (isCheckinSessionStale(existing)) {
      await admin.from("checkin_sessions").update({ status: "finished" }).eq("id", existing.id);
    } else {
      return { alreadyActive: true };
    }
  }

  const excludeIds = opts?.initiatorUserId ? [opts.initiatorUserId] : [];
  let target = await pickCheckinTarget(admin, chatId, excludeIds);
  if (!target && opts?.initiatorUserId) {
    target = await getMember(admin, chatId, opts.initiatorUserId);
  }
  if (!target) return { noMembers: true };

  const { question, a, b } = await generateCheckinQuestion();
  const tag = memberTag(target);
  const now = new Date().toISOString();
  const relayFrom = opts?.initiatorUserId ?? null;

  const { data: session, error } = await admin
    .from("checkin_sessions")
    .insert({
      chat_id: chatId,
      question,
      option_a: a,
      option_b: b,
      target_user_id: target.telegram_user_id,
      tagged_user_ids: [target.telegram_user_id],
      initiator_user_id: opts?.initiatorUserId ?? null,
      relay_from_user_id: relayFrom,
      target_tagged_at: now,
    })
    .select("*")
    .single();
  if (error) throw error;

  await admin
    .from("chat_members")
    .update({ last_checkin_tagged_at: now })
    .eq("chat_id", chatId)
    .eq("telegram_user_id", target.telegram_user_id);

  await telegram.sendChatAction(telegramChatId, "typing");
  await sendCheckinPrompt(admin, session as CheckinSession, telegramChatId, tag);
  scheduleCheckinDeadline(admin, session.id, telegramChatId, opts?.waitUntil);

  return { ok: true };
}

function parseCheckinChoice(text: string): "a" | "b" | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;

  const startsB = /^(б|b|🅱|вариант\s*б|выбираю\s*б|беру\s*б)\b/i.test(t);
  const startsA = /^(а|a|🅰|вариант\s*а|выбираю\s*а|беру\s*а)\b/i.test(t);
  if (startsA && !startsB) return "a";
  if (startsB && !startsA) return "b";

  const wordB = /\b(б|b)\b/i.test(t);
  const wordA = /\b(а|a)\b/i.test(t);
  if (wordA && !wordB) return "a";
  if (wordB && !wordA) return "b";

  if (/скорее\s+(перв|1|один|а|a)/i.test(t)) return "a";
  if (/скорее\s+(втор|2|два|б|b)/i.test(t)) return "b";

  return null;
}

function looksLikeCheckinAnswer(text: string): boolean {
  const t = text.trim();
  if (t.length < 4) return false;
  if (parseCheckinChoice(t)) return true;
  return (
    /выбрал|выберу|беру|скорее|однозначно|потому что|потому|зато|имхо/i.test(t) ||
    t.length >= 12
  );
}

async function relayCheckinAnswer(
  admin: SupabaseClient,
  session: CheckinSession,
  telegramChatId: number,
  fromUserId: number,
  choice: "a" | "b",
  reasonText: string,
  promptMessageId?: number | null,
  waitUntil?: WaitUntilFn,
) {
  const pickedLabel = choice === "b" ? session.option_b : session.option_a;
  const answered = [...(session.answered_user_ids ?? []), fromUserId];

  await admin
    .from("chat_members")
    .update({ last_checkin_answered_at: new Date().toISOString() })
    .eq("chat_id", session.chat_id)
    .eq("telegram_user_id", fromUserId);

  if (promptMessageId) {
    await telegram.editMessageReplyMarkup(telegramChatId, promptMessageId, undefined);
  }

  const reactions = ["кайф выбор", "жиза", "ору", "логично", "спорно но ок", "база"];
  const react = reactions[Math.floor(Math.random() * reactions.length)];
  const excerpt = reasonText.trim().slice(0, 80) + (reasonText.trim().length > 80 ? "…" : "");

  if (answered.length >= CHECKIN_MAX_PARTICIPANTS) {
    await admin
      .from("checkin_sessions")
      .update({ status: "finished", answered_user_ids: answered, pending_choice: choice })
      .eq("id", session.id);
    await telegram.sendMessage(
      telegramChatId,
      `${react}: <b>${pickedLabel}</b> — «${excerpt}». ${CHECKIN_MAX_PARTICIPANTS} человек отметились — чекин закрыт 🧠`,
    );
    return;
  }

  const next = await pickCheckinTarget(admin, session.chat_id, answered);
  if (!next) {
    await admin
      .from("checkin_sessions")
      .update({ status: "finished", answered_user_ids: answered, pending_choice: choice })
      .eq("id", session.id);
    await telegram.sendMessage(
      telegramChatId,
      `${react}: <b>${pickedLabel}</b> — «${excerpt}». На сегодня чекин закрыт 🧠`,
    );
    return;
  }

  const nextTag = memberTag(next);
  const tagged = [...(session.tagged_user_ids ?? []), next.telegram_user_id];
  const now = new Date().toISOString();

  await admin
    .from("checkin_sessions")
    .update({
      answered_user_ids: answered,
      target_user_id: next.telegram_user_id,
      tagged_user_ids: tagged,
      pending_choice: null,
      prompt_message_id: null,
      relay_from_user_id: fromUserId,
      target_tagged_at: now,
    })
    .eq("id", session.id);

  await admin
    .from("chat_members")
    .update({ last_checkin_tagged_at: now })
    .eq("chat_id", session.chat_id)
    .eq("telegram_user_id", next.telegram_user_id);

  const updated: CheckinSession = {
    ...session,
    answered_user_ids: answered,
    target_user_id: next.telegram_user_id,
    tagged_user_ids: tagged,
    relay_from_user_id: fromUserId,
    target_tagged_at: now,
  };
  await sendCheckinPrompt(
    admin,
    updated,
    telegramChatId,
    nextTag,
    `${react}: <b>${pickedLabel}</b> — «${excerpt}»`,
  );
  scheduleCheckinDeadline(admin, session.id, telegramChatId, waitUntil);
}

/** Inline button tap — A or B. */
export async function handleCheckinCallback(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  fromUserId: number,
  sessionId: string,
  choice: "a" | "b",
  callbackQueryId: string,
  promptMessageId?: number | null,
  waitUntil?: WaitUntilFn,
): Promise<void> {
  if (!(await isFeatureEnabled(admin, chatId, "checkin"))) {
    await telegram.answerCallbackQuery(callbackQueryId, "Чекин выключен в этом чате.", true);
    return;
  }

  const { data: sessionRow } = await admin
    .from("checkin_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("chat_id", chatId)
    .eq("status", "active")
    .maybeSingle();
  const session = sessionRow as CheckinSession | null;
  if (!session) {
    await telegram.answerCallbackQuery(callbackQueryId, "Этот чекин уже завершён.", true);
    return;
  }
  if (fromUserId !== session.target_user_id) {
    await telegram.answerCallbackQuery(callbackQueryId, "Сейчас не твоя очередь 🙂", true);
    return;
  }
  if (session.answered_user_ids?.includes(fromUserId)) {
    await telegram.answerCallbackQuery(callbackQueryId, "Ты уже ответил(а)!", true);
    return;
  }

  const pickedLabel = choice === "b" ? session.option_b : session.option_a;
  await telegram.answerCallbackQuery(callbackQueryId, `Выбрал(а): ${pickedLabel}`);
  await relayCheckinAnswer(
    admin,
    session,
    telegramChatId,
    fromUserId,
    choice,
    pickedLabel,
    promptMessageId ?? session.prompt_message_id,
    waitUntil,
  );
}

/** When tagged member answers by text — relay to next. */
export async function handleCheckinMessage(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  fromUserId: number,
  text: string,
  waitUntil?: WaitUntilFn,
): Promise<boolean> {
  if (!(await isFeatureEnabled(admin, chatId, "checkin"))) return false;
  const session = await getActiveCheckin(admin, chatId);
  if (!session) return false;
  if (fromUserId !== session.target_user_id) return false;
  if (session.answered_user_ids?.includes(fromUserId)) return false;

  const choiceFromText = parseCheckinChoice(text);
  if (session.pending_choice && !choiceFromText && text.trim().length < 4) return false;
  if (!session.pending_choice && !looksLikeCheckinAnswer(text)) return false;

  const choice = (choiceFromText ?? session.pending_choice ?? "a") as "a" | "b";
  await relayCheckinAnswer(
    admin,
    session,
    telegramChatId,
    fromUserId,
    choice,
    text.trim() || (choice === "b" ? session.option_b : session.option_a),
    session.prompt_message_id,
    waitUntil,
  );
  return true;
}

export async function runCheckinTick(admin: SupabaseClient) {
  const now = Date.now();
  await expireStaleCheckinSessions(admin);

  const hourUtc = new Date().getUTCHours();
  if (hourUtc < 4 || hourUtc >= 18) return;

  const { data: chats } = await admin
    .from("chats")
    .select("id, telegram_chat_id, bot_settings(*)")
    .eq("is_active", true);

  for (const chat of chats ?? []) {
    try {
      if (!(await isFeatureEnabled(admin, chat.id, "checkin"))) continue;
      const s: any = Array.isArray((chat as any).bot_settings)
        ? (chat as any).bot_settings[0]
        : (chat as any).bot_settings;
      if (!s || s.is_paused) continue;

      const nextAt = s.next_checkin_at ? new Date(s.next_checkin_at).getTime() : 0;
      if (nextAt && now < nextAt) continue;

      const active = await getActiveCheckin(admin, chat.id);
      if (!active) {
        await startCheckin(admin, chat.id, chat.telegram_chat_id);
      }

      await admin
        .from("bot_settings")
        .update({
          next_checkin_at: new Date(now + CHECKIN_INTERVAL_MS).toISOString(),
        })
        .eq("id", s.id);
    } catch (e) {
      console.error(`checkin tick failed for chat ${chat.telegram_chat_id}`, e);
    }
  }
}
