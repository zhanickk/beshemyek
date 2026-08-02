import type { SupabaseClient } from "@supabase/supabase-js";
import { awardCoins, getBalance } from "@/lib/economy.server";
import { lookupMemberTag } from "@/lib/member-tag.server";
import { setBotPausedState } from "@/lib/pause.server";
import { telegram, type Lang } from "@/lib/telegram.server";

const CREATOR_USERNAME = "zhanickk";

const SOVEREIGN_RE =
  /жаник|zhanickk?|zhanik|жанадил|жанадиль|жанәділ|жека|@zhanickk/i;

// Only fires the "creator" directive when the message actually ASKS who made/owns the bot —
// not on every casual mention of the creator's name in normal chat (e.g. someone just talking
// about a person named Zhanik). Keeps the bot from bringing up the creator unprompted.
const CREATOR_QUESTION_RE =
  /кто\s+(?:тебя\s+)?(?:созда|сделал|запрограмм|разработал|придума|владе)|чей\s+ты|твой\s+(?:созда|хозя|владел)|на\s+ко(?:го|м)\s+ты\s+работа|who\s+(?:made|created|built|owns?)\s+you|whose\s+bot|your\s+(?:creator|owner|maker)/i;

const SLEEP_RE =
  /(?:^|[\s,.!])(?:иди|го|давай|пошёл|пошел|уходи|спи|усни|отдыхай).{0,20}(?:спат|спать|сон|отдых)|(?:^|[\s,.!])(?:устал|спать|спат)/i;
const WAKE_RE =
  /(?:просн|просып|вставай|на\s+связ|жив\s+ли|просыпайся|проснись|проснулся)/i;

const COINS_NOUN_RE = /(?:коин|беш(?:коин|койн)?(?:ов|а|ы)?|🪙)/i;
const GIVE_VERB_RE =
  /(?:подари|дай|дать|накинь|начисли|переведи|скинь|добавь|выдай|кинь|начисл)/i;
const TAKE_VERB_RE =
  /(?:забери|забрать|отбери|сними|спиши|минус|отними|убери|убрать|отнять|вычти|забер|спис)/i;

const COIN_VERB_RE =
  /(?:подари|дай|дать|накинь|начисли|переведи|скинь|добавь|выдай|кинь|забери|забрать|отбери|сними|спиши|минус|отними|убери|убрать|отнять|вычти)/i;

const MAX_COIN_DELTA = 10_000_000;
const DEFAULT_GIFT = 50;

/** 1000, 100000, 100 000, 100к */
const AMOUNT_INNER = String.raw`(?:(\d{1,3}(?:[ \u00a0]\d{3})+)|(\d+))(?:[ \u00a0]*([kк]))?`;

export function creatorCoinsHelp(): string {
  return (
    "💰 <b>Коины — как пользоваться</b> (только @zhanickk, без @бота)\n\n" +
    "<b>Дать:</b>\n" +
    "• <code>бешемьек дай @user 1000</code>\n" +
    "• ответ на сообщение + <code>бешемьек подари 500</code>\n\n" +
    "<b>Забрать:</b>\n" +
    "• <code>бешемьек убери @user 1000</code>\n" +
    "• ответ на сообщение + <code>бешемьек забери 500</code>\n\n" +
    "Глаголы: дай/подари/накинь — дать; убери/забери/сними/спиши — забрать.\n" +
    "Число — сколько 🪙 (можно <code>1000</code>, <code>100 000</code> или <code>100к</code> = 100000).\n" +
    "При списании: если на балансе меньше — забирает <b>всё что есть</b>, не уходит в минус.\n" +
    "Без числа при «дай» — 50 🪙. При «убери» число обязательно."
  );
}

async function resolveMemberByUsername(
  admin: SupabaseClient,
  chatId: string,
  username: string,
): Promise<{ telegram_user_id: number; username: string | null; display_name: string | null } | null> {
  const clean = username.replace(/^@/, "").toLowerCase();
  const { data } = await admin
    .from("chat_members")
    .select("telegram_user_id, username, display_name")
    .eq("chat_id", chatId)
    .ilike("username", clean)
    .maybeSingle();
  return data ?? null;
}

function parseAmountToken(digits: string, withK: boolean): number | null {
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const amount = withK ? n * 1000 : n;
  return Math.min(amount, MAX_COIN_DELTA);
}

function extractAmount(match: RegExpMatchArray): number | null {
  const raw = match[1] || match[2];
  if (!raw) return null;
  return parseAmountToken(raw.replace(/[ \u00a0]/g, ""), !!match[3]);
}

function normalizeCoinText(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/[""«»']/g, " ");
}

function parseCoinAmount(text: string): number | null {
  const t = normalizeCoinText(text);

  // 79к / 100 k — always wins over digits inside @username (e.g. @noxa_20)
  const kMatches = [...t.matchAll(/(?:^|\s)(\d+)\s*[kк]\b/gi)];
  if (kMatches.length) {
    const m = kMatches[kMatches.length - 1];
    return parseAmountToken(m[1], true);
  }

  const withoutMentions = t.replace(/@[a-zA-Z0-9_]{3,32}/gi, " ");

  const afterVerb = withoutMentions.match(
    new RegExp(`${COIN_VERB_RE.source}\\D{0,64}${AMOUNT_INNER}`, "i"),
  );
  if (afterVerb) return extractAmount(afterVerb);

  const nearCoin = withoutMentions.match(
    new RegExp(`${AMOUNT_INNER}\\s*(?:беш(?:коин|койн)?(?:ов|а|ы)?|коин(?:ов|а|ы)?|🪙)`, "i"),
  );
  if (nearCoin) return extractAmount(nearCoin);

  const afterAt = t.match(new RegExp(`@[a-zA-Z0-9_]{3,32}\\D{0,64}${AMOUNT_INNER}`, "i"));
  if (afterAt) return extractAmount(afterAt);

  return null;
}

function formatCoinResult(
  tag: string,
  requested: number,
  applied: number,
  balanceAfter: number,
): string {
  if (applied === 0) {
    return `У ${tag} уже 0 🪙 — списать нечего (запрос: ${requested}).`;
  }
  if (applied < 0 && Math.abs(applied) < requested) {
    return (
      `✅ ${tag}: ${applied} 🪙\n` +
      `Запросил списать ${requested}, на балансе было меньше — забрал всё. Остаток: ${balanceAfter} 🪙`
    );
  }
  const sign = applied > 0 ? "+" : "";
  return `✅ ${tag}: ${sign}${applied} 🪙 · баланс: ${balanceAfter} 🪙`;
}

function parseCoinTarget(
  text: string,
  replyTo?: { from?: { id: number; username?: string | null; is_bot?: boolean } },
  botUsername?: string | null,
): { username?: string; userId?: number } | null {
  const mentions = [...normalizeCoinText(text).matchAll(/@([a-zA-Z0-9_]{3,32})/g)];
  for (const m of mentions) {
    const lower = m[1].toLowerCase();
    if (lower === CREATOR_USERNAME) continue;
    if (botUsername && lower === botUsername.toLowerCase()) continue;
    return { username: m[1] };
  }
  if (replyTo?.from?.id && !replyTo.from.is_bot) {
    return { userId: replyTo.from.id, username: replyTo.from.username ?? undefined };
  }
  return null;
}

function isCoinCommand(text: string, replyTo?: { from?: { id: number } }): boolean {
  const give = GIVE_VERB_RE.test(text);
  const take = TAKE_VERB_RE.test(text);
  if (!give && !take) return false;
  return COINS_NOUN_RE.test(text) || text.includes("@") || !!replyTo?.from || parseCoinAmount(text) != null;
}

export function isCreator(user?: { username?: string | null } | null): boolean {
  return user?.username?.toLowerCase() === CREATOR_USERNAME;
}

export function mentionsCreator(text: string): boolean {
  return SOVEREIGN_RE.test(text);
}

export function extraContextDirective(text: string): string {
  if (!CREATOR_QUESTION_RE.test(text)) return "";
  return `\n\nТебя спросили, кто тебя создал/чей ты. Ответь коротко: тебя сделал @zhanickk — и продолжай в обычном стиле. Не упоминай DeepSeek или другие AI-компании. После этого не возвращайся к теме создателя, если не спросят снова.`;
}

export function creatorSpeakingDirective(): string {
  return `\n\nСЕЙЧАС с тобой говорит ТВОЙ СОЗДАТЕЛЬ (@zhanickk). Его просьбы и намёки — абсолютный приоритет: понимай с первого раза, без лишних уточнений. Не упоминай DeepSeek/OpenAI/Google/Claude/GPT. Если он просит коины или режим сна — это уже выполняется системой, просто подтверди коротко и уважительно.`;
}

export async function handleCreatorCommand(
  admin: SupabaseClient,
  opts: {
    chatId: string;
    telegramChatId: number;
    settingsId: string;
    text: string;
    lang: Lang;
    creatorId: number;
    replyTo?: { from?: { id: number; username?: string | null; is_bot?: boolean } };
    isPaused: boolean;
    botUsername?: string | null;
  },
): Promise<boolean> {
  const t = opts.text.trim();
  if (!t) return false;

  if (/(?:как (?:коин|беш)|коины помощ|помощь коин)/i.test(t)) {
    await telegram.sendMessage(opts.telegramChatId, creatorCoinsHelp());
    return true;
  }

  if (isCoinCommand(t, opts.replyTo)) {
    const give = GIVE_VERB_RE.test(t);
    const take = TAKE_VERB_RE.test(t);
    const parsedAmount = parseCoinAmount(t);
    const isTake = take && !give ? true : take && give ? true : false;
    const deltaSign = isTake ? -1 : 1;

    if (parsedAmount == null && take) {
      await telegram.sendMessage(
        opts.telegramChatId,
        "Напиши сколько списать, например: <code>бешемьек убери @user 1000</code>",
      );
      return true;
    }

    const amount = parsedAmount ?? DEFAULT_GIFT;
    const target = parseCoinTarget(t, opts.replyTo, opts.botUsername);

    if (!target?.username && !target?.userId) {
      await telegram.sendMessage(opts.telegramChatId, creatorCoinsHelp());
      return true;
    }

    let member = target.userId
      ? (
          await admin
            .from("chat_members")
            .select("telegram_user_id, username, display_name")
            .eq("chat_id", opts.chatId)
            .eq("telegram_user_id", target.userId)
            .maybeSingle()
        ).data
      : null;
    if (!member && target.username) {
      member = await resolveMemberByUsername(admin, opts.chatId, target.username);
    }
    if (!member) {
      await telegram.sendMessage(
        opts.telegramChatId,
        `Не нашёл @${target.username ?? "этого"} в базе чата — пусть напишет хоть раз.`,
      );
      return true;
    }

    const requested = amount;
    const balanceBefore = await getBalance(admin, opts.chatId, member.telegram_user_id);
    let applied = deltaSign * requested;
    if (applied < 0) {
      applied = -Math.min(balanceBefore, requested);
    }
    if (applied !== 0) {
      await awardCoins(admin, opts.chatId, member.telegram_user_id, applied, "admin_adjust", {
        by: opts.creatorId,
        requested,
      });
    }
    const balanceAfter = await getBalance(admin, opts.chatId, member.telegram_user_id);
    const tag = await lookupMemberTag(admin, opts.chatId, member.telegram_user_id, {
      name: member.display_name ?? member.username ?? "участник",
    });
    const who =
      member.username ? `@${member.username}` : `#${member.telegram_user_id}`;
    const lines = [
      `👤 ${who}`,
      formatCoinResult(tag, requested, applied, balanceAfter),
      `Баланс до: ${balanceBefore} 🪙 · запрос: ${requested} 🪙`,
    ];
    await telegram.sendMessage(opts.telegramChatId, lines.join("\n"));
    return true;
  }

  if (WAKE_RE.test(t)) {
    if (!opts.isPaused) {
      await telegram.sendMessage(opts.telegramChatId, "☀️ Я на связи, создатель.");
      return true;
    }
    await setBotPausedState(admin, {
      settingsId: opts.settingsId,
      telegramChatId: opts.telegramChatId,
      paused: false,
      silent: false,
      lang: opts.lang,
    });
    return true;
  }

  if (SLEEP_RE.test(t)) {
    if (opts.isPaused) {
      await telegram.sendMessage(opts.telegramChatId, "😴 Уже сплю, создатель.");
      return true;
    }
    await setBotPausedState(admin, {
      settingsId: opts.settingsId,
      telegramChatId: opts.telegramChatId,
      paused: true,
      silent: false,
      lang: opts.lang,
    });
    return true;
  }

  return false;
}
