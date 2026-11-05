import { generateText } from "ai";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";
import { buildChatStyleBlock } from "@/lib/chat-style.server";
import { stripLongDashes } from "@/lib/text-format.server";

export type EngagementKind = "silence" | "chime_in" | "nabros";

const FALLBACK_SILENCE = [
  "че как, народ — тут кто-нибудь жив?",
  "капец тишина, кто кинет что-нибудь",
  "гоу хоть мем, а то скучно",
  "ема, чат вымер или все в джейдишках зарылись?",
];

/** Fresh line to break silence — AI when possible, else fallback. */
export async function generateEngagementLine(
  kind: EngagementKind,
  opts?: { chatSnippet?: string },
): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    return FALLBACK_SILENCE[Math.floor(Math.random() * FALLBACK_SILENCE.length)];
  }

  const style = buildChatStyleBlock();
  const prompts: Record<EngagementKind, string> = {
    // Caller prepends a real @tag/mention in front of this line separately (never ask the
    // model to name someone itself — it can't produce a working tg://user mention, only text).
    silence: `Чат молчит 2+ часа днём. Напиши ОДНУ короткую реплику чтобы расшевелить (1-2 предложения макс). Можно: вопрос, подкол, брейнрот, трэш — СВЕЖЕЕ, не шаблон. Не обращайся по имени — реплика начнётся с тега человека отдельно.`,
    nabros: `Случайный вброс в активный треш-чат. Одна короткая живая реплика, СВЕЖАЯ. Не обращайся по имени — реплика начнётся с тега человека отдельно.`,
    chime_in: `Люди активно общаются БЕЗ бота. Если есть что уместно вкинуть (шутка, мнение, подкол) — одна короткая реплика в стиле чата. Если НЕ уверен что уместно — ответь ровно SKIP и больше ничего.`,
  };

  try {
    const provider = createDeepSeekProvider(key);
    const { text } = await generateText({
      model: provider(getDeepSeekModel()),
      system: `Ты Beshemyek Bratan — чуть дерзковат, по-дружески. ${style}\nКаждый раз новые формулировки, не повторяй шаблоны. Только русский.`,
      prompt: `${prompts[kind]}${opts?.chatSnippet ? `\n\nКонтекст чата:\n${opts.chatSnippet}` : ""}`,
    });
    const out = stripLongDashes(text?.trim() || "");
    if (kind === "chime_in" && (/^skip$/i.test(out) || out.length < 3)) return "SKIP";
    return out || FALLBACK_SILENCE[Math.floor(Math.random() * FALLBACK_SILENCE.length)];
  } catch (e) {
    console.error("generateEngagementLine failed", e);
    return FALLBACK_SILENCE[Math.floor(Math.random() * FALLBACK_SILENCE.length)];
  }
}
