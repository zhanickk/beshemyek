import { generateText } from "ai";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";
import { T, AIESEC_GLOSSARY, type Lang } from "@/lib/telegram.server";
import { pickResponseMode, resolveResponseMode } from "@/lib/personality.server";
import { extraContextDirective } from "@/lib/sovereign.server";
import { buildChatStyleBlock, TRASH_CHAT_CHIME_IN_NOTE } from "@/lib/chat-style.server";

export const DEFAULT_AI_TONE =
  "Chill bro vibe, slightly cheeky and playful banter, light teasing, never preachy or toxic.";

const REPLY_STYLE_DIRECTIVE = `\n\nПравила ответа:
- Не тегай (@username) человека, которому отвечаешь, если он сам не просил.
- Не вплетай «создатель», «@zhanickk», «Жаник» в обычный разговор — только если прямо спросили, кто тебя сделал.
- Отвечай по сути, без лишних обращений по имени в каждом сообщении.
- Чуть дерзости ок — уверенный тон, лёгкий подкол, но по-дружески и без хамства.
- Не ставь 😭😢💔 в обычных ответах — это не твой дефолт. Для угара лучше 🤣😁🗿, для хайпа 🔥. Плачущие смайлики — только если собеседник явно расстроен.`;

export async function generateAiReply(
  userMessage: string,
  tone: string,
  lang: Lang,
  chatHistory?: string,
): Promise<string> {
  const mode = lang === "ru" ? pickResponseMode() : "normal";
  const flavor = lang === "ru" ? resolveResponseMode(mode) : { text: null, directive: "" };
  if (flavor.text) return flavor.text;

  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return T.aiFallback[lang];
  const provider = createDeepSeekProvider(key);
  const personalityDirective = flavor.directive ? `\n\n${flavor.directive}` : "";
  const contextDirective = lang === "ru" ? extraContextDirective(userMessage) : "";
  const replyStyle = lang === "ru" ? REPLY_STYLE_DIRECTIVE : "";
  const glossary = Math.random() < 0.25 ? `\n${AIESEC_GLOSSARY}` : "";
  const chatStyle = lang === "ru" ? `\n\n${buildChatStyleBlock(userMessage)}` : "";
  const system = `${T.aiSystem[lang]}\nTone: ${tone}${glossary}${chatStyle}${personalityDirective}${contextDirective}${replyStyle}`;

  const historyBlock = chatHistory
    ? `Недавняя переписка в чате (от старых к новым — ОБЯЗАТЕЛЬНО учитывай контекст, не делай вид что не видел):\n${chatHistory}\n\n${TRASH_CHAT_CHIME_IN_NOTE}\n\n---\n`
    : "";
  const prompt = `${historyBlock}Сообщение, на которое отвечаешь:\n${userMessage}`;

  try {
    const { text } = await generateText({
      model: provider(getDeepSeekModel()),
      system,
      prompt,
    });
    return text?.trim() || T.aiFallback[lang];
  } catch (e) {
    console.error("AI reply failed", e);
    return T.aiFallback[lang];
  }
}
