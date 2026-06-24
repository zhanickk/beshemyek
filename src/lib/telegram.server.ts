import { createHash, timingSafeEqual } from "crypto";

export type Lang = "ru" | "en";

export function detectLanguage(text?: string | null, langCode?: string | null): Lang {
  if (text && /[\u0400-\u04FF]/.test(text)) return "ru";
  if (langCode?.toLowerCase().startsWith("ru")) return "ru";
  return "en";
}

export function resolveLang(
  setting: string | null | undefined,
  text?: string | null,
  langCode?: string | null,
): Lang {
  if (setting === "ru" || setting === "en") return setting;
  return detectLanguage(text, langCode);
}

export const T = {
  help: {
    ru: "Привет! Я помогаю оживить чат.\n\n• <b>/icebreaker</b> — случайный вопрос для разговора\n• <b>/trivia</b> — викторина\n• <b>/poll</b> Вопрос | Вариант 1 | Вариант 2 — свой опрос\n• Упомяните меня через @ или ответьте на моё сообщение — и я отвечу!",
    en: "Hi! I help keep this chat fun.\n\n• <b>/icebreaker</b> — random conversation starter\n• <b>/trivia</b> — quick trivia poll\n• <b>/poll</b> Question | Opt1 | Opt2 — custom poll\n• @mention me or reply to me and I'll chat back!",
  },
  welcome: {
    ru: "👋 Привет всем! Я здесь, чтобы оживлять чат: вопросы для разговора, мини-опросы и дружеские ответы на упоминания. Попробуйте <code>/icebreaker</code>!",
    en: "👋 Hey everyone! I'm here to keep the chat lively with conversation starters, mini-polls, and friendly replies when you @mention me. Try <code>/icebreaker</code> to start!",
  },
  icebreakerLabel: { ru: "💬 <b>Вопрос для разговора:</b>", en: "💬 <b>Icebreaker:</b>" },
  starterLabel: { ru: "💬 <b>Тема для общения:</b>", en: "💬 <b>Conversation starter:</b>" },
  pollUsage: {
    ru: "Использование: <code>/poll Вопрос | Вариант 1 | Вариант 2 | ...</code>",
    en: "Usage: <code>/poll Question | Option 1 | Option 2 | ...</code>",
  },
  pollFailed: { ru: "Не получилось создать опрос: ", en: "Couldn't send poll: " },
  triviaFailed: {
    ru: "Не получилось сгенерировать викторину, попробуйте ещё раз чуть позже.",
    en: "Couldn't generate trivia right now, try again in a moment.",
  },
  triviaPrompt: {
    ru: 'Верни только JSON: {"question":string,"options":[string,string,string,string],"correct":number(0-3)}. Вопрос — интересный, общеобразовательный, на русском языке.',
    en: 'Return only JSON: {"question":string,"options":[string,string,string,string],"correct":number(0-3)}. Question must be a fun, general-knowledge trivia question in English.',
  },
  aiSystem: {
    ru: "Ты добрый и тёплый ведущий группового чата. Отвечай по-русски, 1–3 коротких предложения, поддерживающе и инклюзивно. Заканчивай мягким встречным вопросом, чтобы поддержать разговор. Без сарказма.",
    en: "You are a warm, kind community chat host. Reply in English, 1–3 short sentences, supportive and inclusive. End with a gentle follow-up question. Never be sarcastic.",
  },
  aiFallback: { ru: "Я здесь! О чём думаешь?", en: "I'm here! What's on your mind?" },
};

const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";

function authHeaders() {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const tgKey = process.env.TELEGRAM_API_KEY;
  if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured");
  if (!tgKey) throw new Error("TELEGRAM_API_KEY is not configured");
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": tgKey,
    "Content-Type": "application/json",
  };
}

export function deriveTelegramWebhookSecret(): string {
  const tgKey = process.env.TELEGRAM_API_KEY;
  if (!tgKey) throw new Error("TELEGRAM_API_KEY is not configured");
  return createHash("sha256").update(`telegram-webhook:${tgKey}`).digest("base64url");
}

export function verifyTelegramSecret(headerValue: string | null): boolean {
  if (!headerValue) return false;
  const expected = deriveTelegramWebhookSecret();
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function tgCall<T = any>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}/${endpoint}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Telegram ${endpoint} failed [${res.status}]: ${JSON.stringify(data)}`);
  }
  return data as T;
}

export const telegram = {
  sendMessage: (chatId: number | string, text: string, extra: Record<string, unknown> = {}) =>
    tgCall("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra }),
  sendPoll: (
    chatId: number | string,
    question: string,
    options: string[],
    extra: Record<string, unknown> = {},
  ) => tgCall("sendPoll", { chat_id: chatId, question, options, is_anonymous: false, ...extra }),
  getMe: () => tgCall("getMe", {}),
  setWebhook: (url: string) =>
    tgCall("setWebhook", {
      url,
      secret_token: deriveTelegramWebhookSecret(),
      allowed_updates: ["message", "edited_message", "poll_answer", "my_chat_member"],
    }),
  getWebhookInfo: () => tgCall("getWebhookInfo", {}),
  deleteWebhook: () => tgCall("deleteWebhook", {}),
};
