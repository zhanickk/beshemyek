import { generateText } from "ai";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";

// "Предсказание Бешемека" — a tongue-in-cheek daily horoscope in the local chapter's vibe.
// Fully AI-generated and FRESH each time (no fixed phrase bank), per the variety requirement.

const FALLBACK = [
  "Сегодня звёзды советуют не открывать тот чат, где тебя тегнули три дня назад. Но ты откроешь. И там будет задача.",
  "Прогноз на день: вероятность внезапного созвона — 80%, вероятность что ты к нему готов — округляем до нуля. Держись, всё будет.",
  "Космос шепчет: сегодня твой день, если под «днём» понимать два продуктивных часа между прокрастинацией.",
];

export async function generatePrediction(subjectName: string): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
  try {
    const provider = createDeepSeekProvider(key);
    const { text } = await generateText({
      model: provider(getDeepSeekModel()),
      system:
        "Ты — Beshemyek Bratan. Придумай шуточное «предсказание дня» в стиле локалки AIESEC: короткое (2-3 предложения), с самоиронией и лёгким абсурдом, про студенческую/движовую жизнь. КАЖДЫЙ РАЗ новое и оригинальное — не повторяй шаблоны и заезженные формулировки. Айсековские термины — максимум один и только если в тему, не перегружай жаргоном. Ответь только на русском, верни только текст предсказания без пояснений.",
      prompt: `Сгенерируй свежее предсказание дня для ${subjectName}.`,
    });
    return text?.trim() || FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
  } catch (e) {
    console.error("generatePrediction failed", e);
    return FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
  }
}
