import { generateText } from "ai";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";
import { T, type Lang } from "@/lib/telegram.server";

const FALLBACK_ROASTS = {
  ru: (name: string) => `${name}, ты как дедлайн — все про тебя знают, но никто не готов вовремя.`,
  en: (name: string) =>
    `${name}, you're like a deadline — everyone knows about you, nobody's ready on time.`,
};

export async function generateRoast(name: string, lang: Lang): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  const fallback = FALLBACK_ROASTS[lang](name);
  if (!key) return fallback;
  try {
    const provider = createDeepSeekProvider(key);
    const { text } = await generateText({
      model: provider(getDeepSeekModel()),
      system: T.roastPrompt[lang].replace("{name}", name),
      prompt: lang === "ru" ? "Роастни." : "Roast them.",
    });
    return text?.trim() || fallback;
  } catch (e) {
    console.error("generateRoast failed", e);
    return fallback;
  }
}
