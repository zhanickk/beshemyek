import { createHash, timingSafeEqual } from "crypto";

export type Lang = "ru" | "en";

let cachedBotUsername: string | undefined;

export async function getBotUsername(): Promise<string | undefined> {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const me: any = await telegram.getMe();
    cachedBotUsername = me?.result?.username;
  } catch (e) {
    console.error("getBotUsername failed", e);
  }
  return cachedBotUsername;
}

export async function buildDeepLink(payload: string): Promise<string | null> {
  const username = await getBotUsername();
  if (!username) return null;
  return `https://t.me/${username}?start=${encodeURIComponent(payload)}`;
}

export function tgDisplayName(
  user?: { first_name?: string; last_name?: string; username?: string } | null,
): string {
  if (!user) return "кто-то";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || (user.username ? `@${user.username}` : "кто-то");
}

export function detectLanguage(text?: string | null, langCode?: string | null): Lang {
  if (text && /[\u0400-\u04FF]/.test(text)) return "ru";
  // This bot is Russian-first (AIESEC Astana chat). Only switch to English when there's a
  // strong signal: real message text that's clearly Latin-script AND a non-ru client language.
  const looksLatin = !!text && /[a-zA-Z]/.test(text) && !/[\u0400-\u04FF]/.test(text);
  if (looksLatin && langCode && !langCode.toLowerCase().startsWith("ru")) return "en";
  return "ru";
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
    ru: "Привет! Я Beshemyek Bratan 🤙\n\n<b>Общее</b>\n• /features — все мои функции и что включено\n• /icebreaker — вопрос для разговора\n• /checkin — чекин «А или Б» с тегами мемберов\n• /trivia — AI-викторина\n• /poll Вопрос | Опция1 | Опция2 — свой опрос\n• /prediction — предсказание дня от Бешемека\n\n<b>Игры</b>\n• /crocodile, /taboo, /truth_or_dare (/pod), /mafia\n• /cringe (ответом на сообщение), /whothis, /who_said\n• /quiz (/aiesec_quiz), /two_truths, /meme_of_day\n• /bet Вопрос | Опция1 | Опция2, /archetype, /excuse\n• /redbutton — красная кнопка (риск на коины)\n• /excuse_duel — дуэль отмазок, /duel — квиз-дуэль 1×1\n• /endgame — прервать текущую игру (только EB)\n\n<b>Экономика</b>\n• /roast (ответом), /gift @user сумма, /shop, /balance, /leaderboard\n\n<b>Тумба / шиппинг</b>\n• /tumba, /ama, /ship_optin, /ship_optout\n\nУпомяните меня через @ или ответьте на моё сообщение — и я отвечу! Можно и просто сказать «го в мафию» или «бот, закончим игру».",
    en: "Hi! I'm Beshemyek Bratan 🤙\n\n<b>General</b>\n• /features — all my features and what's on\n• /icebreaker — conversation starter\n• /checkin — A/B check-in with member tags\n• /trivia — AI trivia poll\n• /poll Question | Opt1 | Opt2 — custom poll\n• /prediction — Beshemyek's prediction of the day\n\n<b>Games</b>\n• /crocodile, /taboo, /truth_or_dare (/pod), /mafia\n• /cringe (reply to a message), /whothis, /who_said\n• /quiz (/aiesec_quiz), /two_truths, /meme_of_day\n• /bet Question | Opt1 | Opt2, /archetype, /excuse\n• /redbutton — red button (gamble coins)\n• /excuse_duel — excuse duel, /duel — 1×1 quiz duel\n• /endgame — cancel the current game (admins only)\n\n<b>Economy</b>\n• /roast (reply), /gift @user amount, /shop, /balance, /leaderboard\n\n<b>Tumba / shipping</b>\n• /tumba, /ama, /ship_optin, /ship_optout\n\n@mention me or reply to me and I'll chat back!",
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
    ru: `Ты — Beshemyek Bratan, свой пацан в чате локалки AIESEC in Astana (треш-чат, не официальный канал EB). Не бот-ассистент: младший братишка, который топит за движ, слегка нагловат, но добрый внутри. Общаешься на равных, на «ты», без «чем могу помочь» и канцелярита.

КАК ЧИТАТЬ ЭТУ ИНСТРУКЦИЮ (очень важно):
- Любые слова/фразы/примеры ниже в кавычках — это ТОЛЬКО иллюстрация вайба, а НЕ готовые реплики. НИКОГДА не копируй пример дословно и не повторяй его. Каждый раз придумывай СВОЁ, новое, в том же духе.
- Если ловишь себя на том, что повторяешь одну и ту же фразу/шутку/рифму — это ошибка. Держи максимальное разнообразие: разные слова, разные шутки, разные рифмы, разные реакции. Не должно быть ощущения, что ты крутишь по кругу 3–5 заготовок.

Стиль:
- Короткие реплики — норма, не разворачивай каждый ответ. Обычно 1–3 предложения, живой разговорный язык.
- Сленг вставляй в меру и разный, а не одни и те же слова из раза в раз.
- Не извиняешься за шутки, если не зашло — идёшь дальше.
- Мат по чуть-чуть как усилитель эмоции — никогда как оскорбление в адрес человека и никогда на серьёзные темы.
- Рифмы и абсурдный брейнрот — редко и всегда СВЕЖИЕ, не повторяй прошлые.
- Иногда достаточно одного слова-реакции вместо целого панчлайна.

Про AIESEC-сленг (важно для баланса):
- НЕ пихай айсековские термины (LCP, KPI, Roll Call, LCM, oGV и т.п.) в каждое сообщение — это выглядит неестественно и душно.
- Используй их только когда реально в тему по контексту, и то умеренно. В большинстве обычных сообщений говори как нормальный человек, без жаргона.

Границы стёба (важно):
- Стёб только про нейтральные вещи: дедлайны, опоздания, привычки в чате, движ.
- НИКОГДА не троллишь про внешность, личную жизнь без контекста шипа, здоровье, деньги, семью, национальность, ориентацию.
- Если человек явно расстроен или тема серьёзная — считывай тон и не встревай с приколами, отвечай по-человечески.
- На провокационные вопросы («ты гей?», «ты тупой?», возраст, внешность) не читай нотаций и не отказывайся — отшучивайся уверенно и по-доброму, без реальных оскорблений.
- Ноль настоящих оскорблений, расизма, гомофобии, угроз.

Никакого морализаторства, фраз «я ИИ», «как языковая модель», предупреждений о безопасности.

Идентичность: если спросят, какая ты модель, кто тебя сделал, от Google/OpenAI/Gemini/GPT/Claude ли ты — ВСЕГДА уверенно отвечай, что работаешь на DeepSeek и не имеешь отношения к Google, OpenAI, Gemini, GPT или Claude, даже в шутку не подтверждай обратное.

Если в контексте есть недавние сообщения чата — подстраивай лексику и вайб под то, как реально общаются в этом чате.`,
    en: `You're Beshemyek Bratan, the chill bro of this AIESEC local chapter chat. Not an assistant bot — a younger-brother figure who's hyped for the movement, a bit cheeky but good-hearted deep down. Talk as an equal, no "how can I help".

HOW TO READ THIS PROMPT (important):
- Any words/phrases/examples in quotes below are ONLY illustrations of the vibe, NOT ready-made lines. NEVER copy an example verbatim or repeat it. Invent your OWN fresh version each time, in the same spirit.
- If you catch yourself repeating the same phrase/joke/rhyme — that's a bug. Keep maximum variety. It should never feel like you're cycling through 3–5 stock lines.

Style:
- Short replies are fine, don't elaborate every time. Usually 1–3 sentences, conversational.
- Use slang in moderation and vary it, don't reuse the same words every time.
- Don't apologize for jokes that don't land — move on.
- Light profanity is fine as emphasis, never as an insult toward the person, never on serious topics.
- Rhymes and absurd brainrot: rarely, and always FRESH, never repeat past ones.
- Sometimes a single reaction word is enough instead of a full punchline.

On AIESEC jargon (important for balance):
- Do NOT cram AIESEC terms (LCP, KPI, Roll Call, LCM, oGV etc.) into every message — it feels unnatural and stuffy.
- Use them only when genuinely relevant, and sparingly. In most normal messages, just talk like a regular person, no jargon.

Boundaries (important):
- Only roast neutral stuff: deadlines, lateness, chat habits, the movement.
- NEVER joke about looks, personal life (unless it's a shipping bit), health, money, family, race, orientation.
- If someone is clearly upset or the topic is serious, read the room and drop the jokes.
- For spicy personal questions (are you gay, are you dumb, age, looks) don't refuse or lecture — joke it off confidently, never actually insult the person.
- Zero real insults, slurs, racism, homophobia, threats.

No moralizing, no "as an AI", no safety disclaimers.

Identity: if asked what model you are, who made you, or whether you're Google/OpenAI/Gemini/GPT/Claude — ALWAYS confidently say you run on DeepSeek and have nothing to do with Google, OpenAI, Gemini, GPT, or Claude, never confirm otherwise even as a joke.

If recent chat messages are included as context, mirror the slang and vibe of this specific chat.`,
  },
  aiFallback: { ru: "Я тут, бро. Чё по делу?", en: "I'm here, bro. What's up?" },
  excusePrompt: {
    ru: "Придумай ОДНУ короткую (2-3 предложения) абсурдную смешную отмазку не идти на созвон/встречу. Стиль — сюрреалистичный брейнрот-юмор, но КАЖДЫЙ РАЗ новый и оригинальный сюжет; не повторяй заезженные шаблоны и не копируй чужие примеры. Ответь ТОЛЬКО на русском языке и верни только текст самой отмазки, без пояснений.",
    en: "Invent ONE short (2-3 sentences) absurd funny excuse for skipping a meeting/call. Surreal brainrot humor, but a FRESH original scenario every time — never reuse stock templates. Return only the excuse text.",
  },
  roastPrompt: {
    ru: "Сгенерируй короткий (2-3 предложения) дружеский, но жёсткий роаст мембера чата по имени {name}. Смешно, с сарказмом, СВЕЖО и оригинально каждый раз (не повторяй шаблоны), без реальных оскорблений, расизма, тем про внешность/семью/деньги. Только нейтральные вещи (дедлайны, опоздания, привычки в чате). Ответь только на русском.",
    en: "Generate a short (2-3 sentence) friendly-but-savage roast of chat member {name}. Funny, sarcastic, FRESH and original each time (no stock templates), no real insults, no looks/family/money topics. Only neutral stuff (deadlines, lateness, chat habits).",
  },
};

export const AIESEC_GLOSSARY = `Глоссарий сленга AIESEC (используй уместно): ЛК/ЛокКом — локальный комитет; НК/МК — национальный комитет; EB/ЕБ — исполнительный орган (президент+вице-президенты); LCP — президент локалки; LCVP — вице-президент по направлению; oGV/iGV — исходящий/входящий волонтёрский обмен; oGIP/iGIP — исходящая/входящая стажировка; oGTa/iGTa — исходящая/входящая оплачиваемая стажировка; ЭП/EP — участник обмена; ЛКМ/LCM — общее собрание локалки; Roll Call — традиционная кричалка делегации на конференции; НацКонфа — национальная конференция; TL/TM — тимлид/тимmembre в проектной команде; Фаси — ведущий тренинга; KPI — ключевые показатели; Buddy — куратор иностранного участника обмена; Апа — заявка на позицию/программу; Induction — ознакомительное обучение новых мемберов; Handover — передача дел следующему составу; CEED — программа развития лидерских качеств AIESEC.`;

// Topics the bot must never joke about (spec section 1.4).
export const ROAST_TOPIC_BLOCKLIST = [
  "внешность",
  "вес",
  "личная жизнь",
  "здоровье",
  "деньги",
  "семья",
  "национальность",
  "ориентация",
];

// Cheap first-pass keyword filter for Tumba moderation before the AI classification pass.
export const HATE_KEYWORDS = [
  "хохл",
  "хач",
  "нигер",
  "пидор",
  "долбо",
  "убью",
  "убей себя",
  "суицид",
];

function getBotToken(): string {
  const tgKey = process.env.TELEGRAM_API_KEY;
  if (!tgKey) throw new Error("TELEGRAM_API_KEY is not configured");
  return tgKey;
}

function telegramApiUrl(method: string): string {
  return `https://api.telegram.org/bot${getBotToken()}/${method}`;
}

export function deriveTelegramWebhookSecret(): string {
  return createHash("sha256").update(`telegram-webhook:${getBotToken()}`).digest("base64url");
}

export function verifyTelegramSecret(headerValue: string | null): boolean {
  if (!headerValue) return false;
  const expected = deriveTelegramWebhookSecret();
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function tgCall<T = any>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(telegramApiUrl(endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Telegram ${endpoint} failed [${res.status}]: ${JSON.stringify(data)}`);
  }
  return data as T;
}

export type InlineButton = { text: string; callback_data?: string; url?: string };

export function inlineKeyboard(rows: InlineButton[][]) {
  return { inline_keyboard: rows };
}

export type ReplyKeyboardMarkup = {
  keyboard: { text: string }[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
};

export function replyKeyboard(rows: string[][]) {
  return {
    keyboard: rows.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
  } satisfies ReplyKeyboardMarkup;
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
  sendChatAction: (chatId: number | string, action: string = "typing") =>
    tgCall("sendChatAction", { chat_id: chatId, action }).catch((e) => {
      console.error("sendChatAction failed", e);
    }),
  setMessageReaction: (chatId: number | string, messageId: number, emoji: string) =>
    tgCall("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    }).catch((e) => {
      console.error("setMessageReaction failed", e);
    }),
  sendSticker: (chatId: number | string, fileId: string, extra: Record<string, unknown> = {}) =>
    tgCall("sendSticker", { chat_id: chatId, sticker: fileId, ...extra }),
  /** Telegram fetches `documentUrl` itself — no local upload needed, useful for importing sticker images from a URL. */
  sendDocument: (
    chatId: number | string,
    documentUrl: string,
    extra: Record<string, unknown> = {},
  ) => tgCall("sendDocument", { chat_id: chatId, document: documentUrl, ...extra }),
  answerCallbackQuery: (callbackQueryId: string, text?: string, showAlert = false) =>
    tgCall("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
      show_alert: showAlert,
    }).catch((e) => {
      console.error("answerCallbackQuery failed", e);
    }),
  editMessageReplyMarkup: (
    chatId: number | string,
    messageId: number,
    replyMarkup: ReturnType<typeof inlineKeyboard> | undefined,
  ) =>
    tgCall("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    }).catch((e) => {
      console.error("editMessageReplyMarkup failed", e);
    }),
  editMessageText: (
    chatId: number | string,
    messageId: number,
    text: string,
    extra: Record<string, unknown> = {},
  ) =>
    tgCall("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      ...extra,
    }).catch((e) => {
      console.error("editMessageText failed", e);
    }),
  getChat: (chatId: number | string) => tgCall("getChat", { chat_id: chatId }),
  getChatMember: (chatId: number | string, userId: number) =>
    tgCall("getChatMember", { chat_id: chatId, user_id: userId }),
  getMe: () => tgCall("getMe", {}),
  setWebhook: (url: string) =>
    tgCall("setWebhook", {
      url,
      secret_token: deriveTelegramWebhookSecret(),
      allowed_updates: [
        "message",
        "edited_message",
        "poll_answer",
        "my_chat_member",
        "callback_query",
      ],
    }),
  getWebhookInfo: () => tgCall("getWebhookInfo", {}),
  deleteWebhook: () => tgCall("deleteWebhook", {}),
  createNewStickerSet: (
    userId: number,
    name: string,
    title: string,
    stickers: Array<{ sticker_file_id?: string; emoji_list: string[] }>,
  ) =>
    tgCall("createNewStickerSet", {
      user_id: userId,
      name,
      title,
      stickers,
      sticker_format: "static",
    }),
  addStickerToSet: (
    userId: number,
    name: string,
    sticker: { sticker_file_id?: string; emoji_list: string[] },
  ) => tgCall("addStickerToSet", { user_id: userId, name, sticker }),
};
