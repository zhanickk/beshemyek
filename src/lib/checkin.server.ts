import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText } from "ai";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";
import { telegram } from "@/lib/telegram.server";
import { isFeatureEnabled } from "@/lib/features.server";
import { buildChatStyleBlock } from "@/lib/chat-style.server";

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
}

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
    `${tag}, что выбираешь? Напиши <b>А</b> или <b>Б</b> и коротко почему.`
  );
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
): Promise<{ telegram_user_id: number; username: string | null; display_name: string | null } | null> {
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

export async function startCheckin(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
): Promise<{ ok: true } | { noMembers: true } | { alreadyActive: true }> {
  const existing = await getActiveCheckin(admin, chatId);
  if (existing) return { alreadyActive: true };

  const target = await pickCheckinTarget(admin, chatId);
  if (!target) return { noMembers: true };

  const { question, a, b } = await generateCheckinQuestion();
  const tag = memberTag(target);

  const { data: session, error } = await admin
    .from("checkin_sessions")
    .insert({
      chat_id: chatId,
      question,
      option_a: a,
      option_b: b,
      target_user_id: target.telegram_user_id,
      tagged_user_ids: [target.telegram_user_id],
    })
    .select("*")
    .single();
  if (error) throw error;

  await admin
    .from("chat_members")
    .update({ last_checkin_tagged_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("telegram_user_id", target.telegram_user_id);

  await telegram.sendChatAction(telegramChatId, "typing");
  const sent: any = await telegram.sendMessage(
    telegramChatId,
    formatCheckinPrompt(question, a, b, tag),
  );
  const messageId = sent?.result?.message_id;
  if (messageId) {
    await admin.from("checkin_sessions").update({ prompt_message_id: messageId }).eq("id", session!.id);
  }

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

/** When tagged member answers — relay to next. */
export async function handleCheckinMessage(
  admin: SupabaseClient,
  chatId: string,
  telegramChatId: number,
  fromUserId: number,
  text: string,
): Promise<boolean> {
  if (!(await isFeatureEnabled(admin, chatId, "checkin"))) return false;
  const session = await getActiveCheckin(admin, chatId);
  if (!session) return false;
  if (fromUserId !== session.target_user_id) return false;
  if (session.answered_user_ids?.includes(fromUserId)) return false;
  if (!looksLikeCheckinAnswer(text)) return false;

  const choice = parseCheckinChoice(text) ?? session.pending_choice ?? "a";
  const pickedLabel = choice === "b" ? session.option_b : session.option_a;

  const answered = [...(session.answered_user_ids ?? []), fromUserId];
  await admin
    .from("chat_members")
    .update({ last_checkin_answered_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("telegram_user_id", fromUserId);

  const reactions = ["кайф выбор", "жиза", "ору", "логично", "спорно но ок", "база"];
  const react = reactions[Math.floor(Math.random() * reactions.length)];
  const excerpt = text.trim().slice(0, 80) + (text.trim().length > 80 ? "…" : "");

  const next = await pickCheckinTarget(admin, chatId, answered);
  if (!next) {
    await admin
      .from("checkin_sessions")
      .update({ status: "finished", answered_user_ids: answered, pending_choice: choice })
      .eq("id", session.id);
    await telegram.sendMessage(
      telegramChatId,
      `${react}: <b>${pickedLabel}</b> — «${excerpt}». На сегодня чекин закрыт 🧠`,
    );
    return true;
  }

  const nextTag = memberTag(next);
  const tagged = [...(session.tagged_user_ids ?? []), next.telegram_user_id];

  await admin
    .from("checkin_sessions")
    .update({
      answered_user_ids: answered,
      target_user_id: next.telegram_user_id,
      tagged_user_ids: tagged,
      pending_choice: null,
      prompt_message_id: null,
    })
    .eq("id", session.id);

  await admin
    .from("chat_members")
    .update({ last_checkin_tagged_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("telegram_user_id", next.telegram_user_id);

  const sent: any = await telegram.sendMessage(
    telegramChatId,
    `${react}: <b>${pickedLabel}</b> — «${excerpt}»\n\n${formatCheckinPrompt(session.question, session.option_a, session.option_b, nextTag)}`,
  );
  const msgId = sent?.result?.message_id;
  if (msgId) {
    await admin.from("checkin_sessions").update({ prompt_message_id: msgId }).eq("id", session.id);
  }
  return true;
}

export async function runCheckinTick(admin: SupabaseClient) {
  const now = Date.now();
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
          next_checkin_at: new Date(now + (4 + Math.random() * 3) * 3600 * 1000).toISOString(),
        })
        .eq("id", s.id);
    } catch (e) {
      console.error(`checkin tick failed for chat ${chat.telegram_chat_id}`, e);
    }
  }
}
