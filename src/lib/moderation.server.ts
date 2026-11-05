import { generateText } from "ai";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";
import { HATE_KEYWORDS } from "@/lib/telegram.server";

const PERSONAL_DATA_PATTERNS = [
  /\+?\d[\d\s\-()]{7,}\d/, // phone-ish
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/, // email
  /\b\d{6}\s?\d{6}\b/, // passport/IIN-ish long digit runs
];

export interface ModerationResult {
  approved: boolean;
  reason?: string;
}

/** Cheap keyword + pattern pass, used before the (slower, costlier) AI pass. */
export function quickModerationCheck(text: string): ModerationResult {
  const lower = text.toLowerCase();
  for (const word of HATE_KEYWORDS) {
    if (lower.includes(word)) return { approved: false, reason: "hate_keyword" };
  }
  for (const pattern of PERSONAL_DATA_PATTERNS) {
    if (pattern.test(text)) return { approved: false, reason: "personal_data" };
  }
  return { approved: true };
}

/** AI classification pass for content that clears the keyword filter. */
export async function aiModerationCheck(text: string): Promise<ModerationResult> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return { approved: true }; // fail-open if AI unavailable, keyword pass already ran
  try {
    const provider = createDeepSeekProvider(key);
    const { text: raw } = await generateText({
      model: provider(getDeepSeekModel()),
      system:
        'Ты модератор анонимных сообщений в чат-боте. Верни ТОЛЬКО JSON {"approved":boolean,"reason":string|null}. ' +
        "approved=false если сообщение содержит явную ненависть/оскорбления по национальности/ориентации/религии, угрозы насилия, призывы к суициду, или личные данные (телефон, адрес, паспорт). " +
        "Дружеские подколки, лёгкий мат, комплименты и флирт — approved=true.",
      prompt: text,
    });
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return { approved: !!parsed.approved, reason: parsed.reason ?? undefined };
  } catch (e) {
    console.error("aiModerationCheck failed", e);
    return { approved: true }; // fail-open on parse/network errors
  }
}

export async function moderateText(text: string): Promise<ModerationResult> {
  const quick = quickModerationCheck(text);
  if (!quick.approved) return quick;
  return aiModerationCheck(text);
}

const CAPS_WINDOW_MS = 10 * 60 * 1000;
const CAPS_STRIKE_LIMIT = 3;

/** Returns true if the message looks like spammy all-caps shouting. */
export function isCapsSpam(text: string): boolean {
  const letters = text.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, "");
  if (letters.length < 8) return false;
  const upper = letters.replace(/[^A-ZА-ЯЁ]/g, "");
  return upper.length / letters.length > 0.7;
}

/** Tracks caps-spam strikes per member; returns true once the strike limit is exceeded (rate-limit trigger). */
export function shouldThrottleCaps(lastCapsAt: string | null, capsStrikes: number): boolean {
  if (!lastCapsAt) return false;
  const withinWindow = Date.now() - new Date(lastCapsAt).getTime() < CAPS_WINDOW_MS;
  return withinWindow && capsStrikes >= CAPS_STRIKE_LIMIT;
}
