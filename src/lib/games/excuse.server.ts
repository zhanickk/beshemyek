import { generateText } from "ai";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";
import { T, type Lang } from "@/lib/telegram.server";

const FALLBACK_EXCUSES = {
  ru: [
    "Братишка, не могу на созвон — у кошки начался mewing, держу ей челюсть, это важнее вашего айсека.",
    "Застрял в текстурах Центрального парка, шлите GV-шников на спасение.",
    "Роутер ушёл в глубокую медитацию, вернётся после LCM, наверное.",
  ],
  en: [
    "Bro I can't make the call, my cat started mewing and I'm holding its jaw, that's more urgent than AIESEC.",
    "Stuck in the textures of Central Park, send the GVs to rescue me.",
    "My router entered deep meditation, will be back sometime after the meeting, probably.",
  ],
};

export async function generateExcuse(lang: Lang): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  const fallback =
    FALLBACK_EXCUSES[lang][Math.floor(Math.random() * FALLBACK_EXCUSES[lang].length)];
  if (!key) return fallback;
  try {
    const provider = createDeepSeekProvider(key);
    const { text } = await generateText({
      model: provider(getDeepSeekModel()),
      system: T.excusePrompt[lang],
      prompt: lang === "ru" ? "Сгенерируй отмазку." : "Generate an excuse.",
    });
    return text?.trim() || fallback;
  } catch (e) {
    console.error("generateExcuse failed", e);
    return fallback;
  }
}
