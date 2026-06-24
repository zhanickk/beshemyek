import { createHash, timingSafeEqual } from "crypto";

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
