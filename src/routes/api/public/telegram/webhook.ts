import { createFileRoute } from "@tanstack/react-router";
import { generateText } from "ai";
import { createDeepSeekProvider, getDeepSeekModel } from "@/lib/ai-gateway.server";
import {
  telegram,
  verifyTelegramSecret,
  resolveLang,
  detectLanguage,
  tgDisplayName,
  buildDeepLink,
  T,
  AIESEC_GLOSSARY,
  type Lang,
} from "@/lib/telegram.server";
import { getAdmin } from "@/lib/supabase-admin.server";
import {
  ensureMember,
  awardCoins,
  spendCoins,
  getBalance,
  getLeaderboard,
} from "@/lib/economy.server";
import {
  isFeatureEnabled,
  getFeatureMap,
  buildFeaturesOverview,
  type FeatureKey,
} from "@/lib/features.server";
import { moderateText, isCapsSpam } from "@/lib/moderation.server";
import { pickSticker } from "@/lib/stickers.server";
import { handlePollAnswer } from "@/lib/quiz.server";
import {
  getActiveSession,
  getSessionByShortCode,
  parseCallback,
  cancelSession,
  GAME_LABELS,
  type GameCtx,
} from "@/lib/games/engine.server";
import {
  startCrocodile,
  resendCrocodileWord,
  handleCrocodileMessage,
  handleCrocodileCallback,
} from "@/lib/games/crocodile.server";
import { startTaboo, resendTabooCard, handleTabooMessage, handleTabooCallback, handleTabooPrivateMessage } from "@/lib/games/taboo.server";
import { startCringeGame, handleCringeCallback } from "@/lib/games/cringe.server";
import { startTruthOrDare, handleTruthOrDareCallback } from "@/lib/games/truth_or_dare.server";
import {
  startMafiaLobby,
  resendMafiaRole,
  handleMafiaCallback,
  applyMafiaImmunityPurchase,
} from "@/lib/games/mafia.server";
import { startAiesecQuiz, handleAiesecQuizCallback } from "@/lib/games/aiesec_quiz.server";
import {
  beginTwoTruthsDialog,
  handleTwoTruthsDialogMessage,
  finalizeTwoTruths,
  handleTwoTruthsCallback,
} from "@/lib/games/two_truths.server";
import {
  startMemeOfDay,
  handleMemeMessage,
  handleMemeCallback,
} from "@/lib/games/meme_of_day.server";
import {
  startTotalizator,
  handleTotalizatorCallback,
  resolveTotalizator,
} from "@/lib/games/totalizator.server";
import { startArchetypeQuiz, handleArchetypeCallback } from "@/lib/games/archetype_quiz.server";
import { startRedButton, handleRedButtonCallback } from "@/lib/games/red_button.server";
import { startExcuseDuel, handleExcuseDuelCallback } from "@/lib/games/excuse_duel.server";
import { startQuizDuel, handleQuizDuelCallback } from "@/lib/games/quiz_duel.server";
import {
  generatePrediction,
  predictionMemberFromTg,
  resolvePredictionTargets,
} from "@/lib/prediction.server";
import { detectGameIntent, type NaturalGameKey, type GameIntent } from "@/lib/games/intent.server";
import { generateExcuse } from "@/lib/games/excuse.server";
import { generateRoast } from "@/lib/games/roast.server";
import {
  beginTumbaDialog,
  handleTumbaCategoryChoice,
  handleTumbaDialogMessage,
  postTumbaDigest,
  sendTumbaGroupReminder,
  looksLikeTumbaIntent,
  type TumbaCategory,
} from "@/lib/tumba.server";
import { pickResponseMode, resolveResponseMode } from "@/lib/personality.server";
import { buildChatStyleBlock, TRASH_CHAT_CHIME_IN_NOTE } from "@/lib/chat-style.server";
import { buildChatHistoryContext } from "@/lib/chat-context.server";
import { tryOrganicChimeIn } from "@/lib/engagement.server";
import { handleCheckinMessage, startCheckin } from "@/lib/checkin.server";
import {
  DM_MENU,
  DM_MENU_TEXTS,
  buildDmReplyKeyboard,
  buildFeaturesRootKeyboard,
  buildFeaturesCategoryKeyboard,
  buildFeaturesItemKeyboard,
  featuresRootText,
  featuresCategoryText,
  featuresItemText,
  findMenuItem,
  getMenuItem,
  MENU_BY_CATEGORY,
  type FeatureCategory,
  type FeatureMenuId,
  buildShopBuyKeyboard,
} from "@/lib/keyboards.server";
import { runDueTicksForChat } from "@/lib/cron.server";

function scheduleDueTicks(admin: ReturnType<typeof getAdmin>, chatUuid: string) {
  void runDueTicksForChat(admin, chatUuid).catch((e) => console.error("due tick piggyback failed", e));
}

async function sendDmWithMenu(chatId: number, text: string) {
  await telegram.sendMessage(chatId, text, { reply_markup: buildDmReplyKeyboard() });
}

async function resolveUserChat(admin: ReturnType<typeof getAdmin>, telegramUserId: number) {
  const chat = await resolveSingleChatForUser(admin, telegramUserId);
  if (chat === null) {
    await sendDmWithMenu(
      telegramUserId,
      "Сначала напиши что-нибудь в общем чате локалки, чтобы я тебя знал 🙂",
    );
    return null;
  }
  if (chat === "multiple") {
    await sendDmWithMenu(
      telegramUserId,
      "Ты в нескольких чатах со мной — эту кнопку лучше жми в нужной группе.",
    );
    return null;
  }
  return chat;
}

async function handleDmMenuAction(
  admin: ReturnType<typeof getAdmin>,
  telegramUserId: number,
  label: string,
  lang: Lang,
) {
  const chat = await resolveUserChat(admin, telegramUserId);
  if (!chat) return;

  switch (label) {
    case DM_MENU.balance: {
      const balance = await getBalance(admin, chat.id, telegramUserId);
      await sendDmWithMenu(telegramUserId, `💰 У тебя <b>${balance}</b> БешКоинов.`);
      return;
    }
    case DM_MENU.shop: {
      const { data: items } = await admin
        .from("shop_items")
        .select("*")
        .or(`chat_id.eq.${chat.id},chat_id.is.null`)
        .eq("is_active", true);
      if (!items?.length) {
        await sendDmWithMenu(telegramUserId, "Магазин пуст.");
        return;
      }
      await telegram.sendMessage(
        telegramUserId,
        `🛍 <b>Магазин Бешемека</b>\n${items.map((i) => `${i.title} — ${i.price} 🪙\n<i>${i.description ?? ""}</i>`).join("\n\n")}`,
        {
          reply_markup: buildShopBuyKeyboard(items),
        },
      );
      await telegram.sendMessage(telegramUserId, "👇", { reply_markup: buildDmReplyKeyboard() });
      return;
    }
    case DM_MENU.top: {
      const top = await getLeaderboard(admin, chat.id, 10);
      const lines = top.map(
        (m, i) =>
          `${i + 1}. ${m.display_name || (m.username ? `@${m.username}` : `#${m.telegram_user_id}`)} — ${m.coins} 🪙`,
      );
      await sendDmWithMenu(
        telegramUserId,
        lines.length ? `🏆 <b>Лидерборд</b>\n${lines.join("\n")}` : "Лидерборд пуст.",
      );
      return;
    }
    case DM_MENU.gift:
      await sendDmWithMenu(
        telegramUserId,
        "🎁 Чтобы подарить коины, напиши в групповом чате:\n<code>/gift @username сумма</code>",
      );
      return;
    case DM_MENU.commands:
      await sendDmWithMenu(telegramUserId, T.help[lang]);
      return;
    case DM_MENU.prediction: {
      if (!(await isFeatureEnabled(admin, chat.id, "prediction"))) {
        await sendDmWithMenu(telegramUserId, "Предсказания выключены в твоём чате.");
        return;
      }
      const { intro, text } = await generatePrediction({
        admin,
        chatId: chat.id,
        invoker: predictionMemberFromTg({ id: telegramUserId, first_name: "ты" }),
      });
      await sendDmWithMenu(telegramUserId, `${intro}\n${text}`);
      return;
    }
    case DM_MENU.excuse: {
      if (!(await isFeatureEnabled(admin, chat.id, "excuse"))) {
        await sendDmWithMenu(telegramUserId, "Отмазки выключены в твоём чате.");
        return;
      }
      const excuse = await generateExcuse(lang);
      await sendDmWithMenu(telegramUserId, excuse);
      return;
    }
    case DM_MENU.tumba: {
      if (!(await isFeatureEnabled(admin, chat.id, "tumba"))) {
        await sendDmWithMenu(telegramUserId, "Тумба выключена в твоём чате.");
        return;
      }
      await beginTumbaDialog(admin, telegramUserId, chat.id);
      await telegram.sendMessage(telegramUserId, "👇", { reply_markup: buildDmReplyKeyboard() });
      return;
    }
    case DM_MENU.settings:
      await sendDmWithMenu(
        telegramUserId,
        "⚙️ Настройки бота для чата меняются в веб-дашборде EB.\nВ группе: <code>/features</code> — что включено.",
      );
      return;
  }
}

async function handleFeaturesCallback(
  admin: ReturnType<typeof getAdmin>,
  cb: any,
  data: string,
) {
  const chatTelegramId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const fromUser: TgUser = cb.from;
  const fromName = tgDisplayName(fromUser);
  if (!chatTelegramId || !messageId) {
    await telegram.answerCallbackQuery(cb.id);
    return;
  }
  const { data: chatRow } = await admin
    .from("chats")
    .select("id")
    .eq("telegram_chat_id", chatTelegramId)
    .maybeSingle();
  if (!chatRow) {
    await telegram.answerCallbackQuery(cb.id);
    return;
  }
  const map = await getFeatureMap(admin, chatRow.id);
  const parts = data.split(":");
  const action = parts[1];

  if (action === "back") {
    const category = parts[2] as FeatureCategory | undefined;
    if (category && MENU_BY_CATEGORY[category]) {
      await telegram.editMessageText(
        chatTelegramId,
        messageId,
        featuresCategoryText(map, category),
        { reply_markup: buildFeaturesCategoryKeyboard(map, category) },
      );
    } else {
      await telegram.editMessageText(chatTelegramId, messageId, featuresRootText(map), {
        reply_markup: buildFeaturesRootKeyboard(),
      });
    }
    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  if (action === "run") {
    const itemId = parts[2] as FeatureMenuId;
    const found = findMenuItem(itemId);
    if (!found || !found.item.launchable || !map[found.item.featureKey]) {
      await telegram.answerCallbackQuery(cb.id, "Фича выключена или недоступна.", true);
      return;
    }
    await telegram.answerCallbackQuery(cb.id, "Запускаю…");
    const ctx: GameCtx = {
      admin,
      chatId: chatRow.id,
      telegramChatId: chatTelegramId,
      lang: "ru",
    };
    const invoker = { id: fromUser.id, name: fromName };
    const msg = await launchFeatureFromMenu(ctx, chatRow, invoker, itemId);
    if (msg) await telegram.sendMessage(chatTelegramId, msg);
    return;
  }

  const category = action as FeatureCategory;
  const itemId = parts[2];

  if (itemId && MENU_BY_CATEGORY[category]) {
    const item = getMenuItem(category, itemId);
    if (!item) {
      await telegram.answerCallbackQuery(cb.id);
      return;
    }
    await telegram.editMessageText(
      chatTelegramId,
      messageId,
      featuresItemText(map, category, item),
      { reply_markup: buildFeaturesItemKeyboard(map, category, item) },
    );
    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  if (MENU_BY_CATEGORY[category]) {
    await telegram.editMessageText(
      chatTelegramId,
      messageId,
      featuresCategoryText(map, category),
      { reply_markup: buildFeaturesCategoryKeyboard(map, category) },
    );
    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  await telegram.answerCallbackQuery(cb.id);
}

async function launchFeatureFromMenu(
  ctx: GameCtx,
  chatRow: { id: string },
  invoker: { id: number; name: string },
  itemId: FeatureMenuId,
): Promise<string | null> {
  const activeMsg =
    "Сейчас уже идёт другая игра, закончите её сначала (или EB может прервать через /endgame).";

  switch (itemId) {
    case "mafia": {
      const r = await startMafiaLobby(ctx, invoker);
      return (r as any).alreadyActive ? activeMsg : null;
    }
    case "crocodile": {
      const r = await startCrocodile(ctx, invoker);
      return (r as any).alreadyActive ? activeMsg : null;
    }
    case "truth_or_dare": {
      const r = await startTruthOrDare(ctx, invoker);
      return (r as any).alreadyActive ? activeMsg : null;
    }
    case "taboo": {
      const r = await startTaboo(ctx, invoker);
      return (r as any).alreadyActive ? activeMsg : null;
    }
    case "who_said_this": {
      const r = await startCringeGame(ctx, "who_said");
      if ((r as any).alreadyActive) return activeMsg;
      if ((r as any).noEntries)
        return "Мало цитат — отметь угар через /cringe в ответ на сообщение, или подожди пока бот наберёт из чата.";
      return null;
    }
    case "aiesec_quiz": {
      const r = await startAiesecQuiz(ctx);
      return (r as any).alreadyActive
        ? activeMsg
        : (r as any).noQuestions
          ? "Пока нет вопросов в базе квиза."
          : null;
    }
    case "two_truths": {
      try {
        await beginTwoTruthsDialog(ctx.admin, invoker.id, chatRow.id);
        return `${invoker.name}, я написал тебе в личку — заполняй свои 3 факта там 📩`;
      } catch {
        const link = await buildDeepLink(`tt_${chatRow.id}`);
        return `${invoker.name}, не смог написать в личку 😅 ${link ? `Открой: ${link} и жми /start` : "Напиши мне /start в личке."}`;
      }
    }
    case "meme_of_day": {
      const r = await startMemeOfDay(ctx);
      return (r as any).alreadyActive ? "Мем дня уже идёт!" : null;
    }
    case "archetype_quiz": {
      const r = await startArchetypeQuiz(ctx, invoker);
      if ((r as any).alreadyActive) return activeMsg;
      if ((r as any).noQuestions) return "Пока нет вопросов для теста.";
      return null;
    }
    case "red_button": {
      const r = await startRedButton(ctx, invoker);
      return (r as any).alreadyActive ? activeMsg : null;
    }
    case "excuse_duel": {
      const r = await startExcuseDuel(ctx);
      if ((r as any).alreadyActive) return activeMsg;
      if ((r as any).notEnough)
        return "Маловато активных участников для дуэли — нужно хотя бы двое.";
      return null;
    }
    case "quiz_duel": {
      const r = await startQuizDuel(ctx, invoker);
      if ((r as any).alreadyActive) return activeMsg;
      if ((r as any).notEnough) return "Маловато вопросов в базе квиза для дуэли.";
      return null;
    }
    case "balance": {
      const balance = await getBalance(ctx.admin, chatRow.id, invoker.id);
      return `💰 У тебя ${balance} БешКоинов.`;
    }
    case "shop": {
      const { data: items } = await ctx.admin
        .from("shop_items")
        .select("*")
        .or(`chat_id.eq.${chatRow.id},chat_id.is.null`)
        .eq("is_active", true);
      if (!items?.length) return "Магазин пуст.";
      await telegram.sendMessage(
        ctx.telegramChatId,
        `🛍 <b>Магазин Бешемека</b>\n${items.map((i) => `${i.title} — ${i.price} 🪙\n<i>${i.description ?? ""}</i>`).join("\n\n")}`,
        {
          reply_markup: buildShopBuyKeyboard(items),
        },
      );
      return null;
    }
    case "leaderboard": {
      const top = await getLeaderboard(ctx.admin, chatRow.id, 10);
      if (!top.length) return "Лидерборд пуст.";
      const lines = top.map(
        (m, i) =>
          `${i + 1}. ${m.display_name || (m.username ? `@${m.username}` : `#${m.telegram_user_id}`)} — ${m.coins} 🪙`,
      );
      return `🏆 <b>Лидерборд БешКоинов</b>\n${lines.join("\n")}`;
    }
    case "tumba":
      await sendTumbaGroupReminder(ctx.telegramChatId, chatRow.id, invoker.name);
      return null;
    case "ama": {
      let dmOk = false;
      try {
        await beginTumbaDialog(ctx.admin, invoker.id, chatRow.id, "ama");
        dmOk = true;
      } catch {
        // fall through
      }
      if (!dmOk) {
        const link = await buildDeepLink(`ama_${chatRow.id}`);
        return `${invoker.name}, напиши мне в личку 🎤 ${link ? `Открой: ${link} и жми /start` : ""}`;
      }
      return `${invoker.name}, я написал тебе в личку — кидай вопрос для EB 🎤`;
    }
    case "shipping":
      await ctx.admin
        .from("chat_members")
        .update({ shipping_opt_in: true })
        .eq("chat_id", chatRow.id)
        .eq("telegram_user_id", invoker.id);
      await telegram.sendMessage(
        ctx.telegramChatId,
        "💘 Ты в шипперинге! Бот может подкинуть тебя в пару.",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚫 Не участвую", callback_data: `ship_toggle:${chatRow.id}` }],
            ],
          },
        },
      );
      return null;
    case "prediction": {
      const { intro, text } = await generatePrediction({
        admin: ctx.admin,
        chatId: chatRow.id,
        invoker: {
          telegram_user_id: invoker.id,
          username: null,
          display_name: invoker.name,
        },
      });
      return `${intro}\n${text}`;
    }
    case "excuse":
      return await generateExcuse("ru");
    default:
      return null;
  }
}

async function generateAiReply(
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
  const glossary = Math.random() < 0.25 ? `\n${AIESEC_GLOSSARY}` : "";
  const chatStyle = lang === "ru" ? `\n\n${buildChatStyleBlock(userMessage)}` : "";
  const system = `${T.aiSystem[lang]}\nTone: ${tone}${glossary}${chatStyle}${personalityDirective}`;

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

type TgUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
  language_code?: string;
};
type TgChat = { id: number; type: string; title?: string; username?: string };
type TgEntity = { type: string; offset: number; length: number };
type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  entities?: TgEntity[];
  reply_to_message?: { message_id: number; from?: TgUser; text?: string };
  photo?: unknown;
  animation?: unknown;
};

const REACTION_EMOJI = ["😁", "🔥", "👍", "😂", "🤝", "❤️"];

// Word-trigger reactions: when a message contains a matching word, the bot may drop a fitting
// emoji reaction. Each group lists several emojis (from Telegram's allowed reaction set) so the
// same trigger doesn't always get the exact same emoji — keeps it varied.
const TRIGGER_REACTIONS: Array<{ re: RegExp; emojis: string[] }> = [
  { re: /дедлайн|горит|завал|срочн|аврал/i, emojis: ["🔥", "😱", "🤯"] },
  { re: /устал|вырубаюсь|сплю|спать|выгор|нет сил/i, emojis: ["😴", "🥱", "😭"] },
  { re: /жиза|факт|реально так|согласен|база\b|соглас/i, emojis: ["💯", "👍", "🫡"] },
  { re: /поздрав|днюха|день рожден|ура\b|победа|выиграл|прошли|сдал/i, emojis: ["🎉", "🏆", "🤩"] },
  { re: /грустн|печаль|жаль|плохо мне|обидно|расстро/i, emojis: ["😢", "💔", "🙏"] },
  { re: /краш|влюб|люблю|обожаю|милота|сердечк/i, emojis: ["😍", "❤️‍🔥", "🥰"] },
  { re: /ржу|ору\b|лол\b|ахах|хаха|смешно|угар|рофл/i, emojis: ["🤣", "😁", "🤡"] },
  { re: /жесть|капец|ужас|шок|офиг|в шоке|дичь/i, emojis: ["🤯", "😱", "🗿"] },
  { re: /гений|умн|мозг|интеллект|шар(и|яг)/i, emojis: ["🤓", "🤝", "👏"] },
  { re: /кринж|стыдно|неловк|зашквар/i, emojis: ["🤡", "🙈", "🌚"] },
  { re: /еда|голод|кушать|пожрать|пицц|вкусно/i, emojis: ["🍌", "🍾", "😋"] },
];

function pickTriggerReaction(text: string): string | null {
  const matches = TRIGGER_REACTIONS.filter((g) => g.re.test(text));
  if (matches.length === 0) return null;
  const group = matches[Math.floor(Math.random() * matches.length)];
  return group.emojis[Math.floor(Math.random() * group.emojis.length)];
}

async function ensureChat(admin: ReturnType<typeof getAdmin>, chat: TgChat) {
  let { data: chatRow } = await admin
    .from("chats")
    .select("*")
    .eq("telegram_chat_id", chat.id)
    .maybeSingle();
  if (!chatRow) {
    const { data: ins } = await admin
      .from("chats")
      .insert({
        telegram_chat_id: chat.id,
        title: chat.title ?? chat.username ?? "Private chat",
        chat_type: chat.type,
        is_active: true,
      })
      .select("*")
      .single();
    if (ins) {
      chatRow = ins;
      await admin.from("bot_settings").insert({ chat_id: ins.id });
    }
  }
  return chatRow;
}

async function resolveSingleChatForUser(
  admin: ReturnType<typeof getAdmin>,
  telegramUserId: number,
): Promise<{ id: string; telegram_chat_id: number } | null | "multiple"> {
  const { data } = await admin
    .from("chat_members")
    .select("chat_id, chats!inner(id, telegram_chat_id, is_active)")
    .eq("telegram_user_id", telegramUserId);
  const active = (data ?? []).map((r: any) => r.chats).filter((c: any) => c.is_active);
  const unique = Array.from(new Map(active.map((c: any) => [c.id, c])).values()) as any[];
  if (unique.length === 0) return null;
  if (unique.length > 1) return "multiple";
  return unique[0];
}

async function isTelegramChatAdmin(chatId: number, userId: number): Promise<boolean> {
  try {
    const res: any = await telegram.getChatMember(chatId, userId);
    return ["administrator", "creator"].includes(res?.result?.status);
  } catch {
    return false;
  }
}

// ── natural-language game start/end ("гоу в мафию поиграем" / "бот закончи игру") ──────────

const NATURAL_GAME_LABELS: Record<NaturalGameKey, string> = {
  crocodile: "Крокодил",
  taboo: "Табу",
  truth_or_dare: "Правда или действие",
  mafia: "Мафия",
  cringe: "Кто этот Кринж",
  who_said: "Кто это сказал",
  aiesec_quiz: "AIESEC квиз",
  two_truths: "Два правды и одна ложь",
  meme_of_day: "Мем дня",
  archetype_quiz: "Архетип-тест",
  red_button: "Красная кнопка",
  excuse_duel: "Дуэль отмазок",
  quiz_duel: "Квиз-дуэль 1×1",
};

const NATURAL_GAME_CODE: Record<NaturalGameKey, string> = {
  crocodile: "cr",
  taboo: "tb",
  truth_or_dare: "td",
  mafia: "mf",
  cringe: "cg",
  who_said: "ws",
  aiesec_quiz: "aq",
  two_truths: "tt",
  meme_of_day: "md",
  archetype_quiz: "ar",
  red_button: "rb",
  excuse_duel: "ed",
  quiz_duel: "qd",
};
const NATURAL_CODE_TO_GAME: Record<string, NaturalGameKey> = Object.fromEntries(
  Object.entries(NATURAL_GAME_CODE).map(([k, v]) => [v, k as NaturalGameKey]),
) as Record<string, NaturalGameKey>;

const NATURAL_GAME_FEATURE_KEY: Record<NaturalGameKey, FeatureKey> = {
  crocodile: "crocodile",
  taboo: "taboo",
  truth_or_dare: "truth_or_dare",
  mafia: "mafia",
  cringe: "cringe",
  who_said: "who_said_this",
  aiesec_quiz: "aiesec_quiz",
  two_truths: "two_truths",
  meme_of_day: "meme_of_day",
  archetype_quiz: "archetype_quiz",
  red_button: "red_button",
  excuse_duel: "excuse_duel",
  quiz_duel: "quiz_duel",
};

async function handleGameIntent(
  admin: ReturnType<typeof getAdmin>,
  chatRow: { id: string },
  chatId: number,
  intent: GameIntent,
  invoker: { id: number; name: string },
) {
  if (!intent) return;

  await telegram.sendChatAction(chatId, "typing");

  if (intent.kind === "end") {
    const active = await getActiveSession(admin, chatRow.id);
    if (!active) {
      await telegram.sendMessage(chatId, "Сейчас нет активной игры, братан.");
      return;
    }
    await telegram.sendMessage(
      chatId,
      `А вы точно хотите прервать игру «${GAME_LABELS[active.type]}»? Подтверди, только EB может.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Да, завершить", callback_data: "ngc:ey" },
              { text: "❌ Нет, продолжаем", callback_data: "ngc:en" },
            ],
          ],
        },
      },
    );
    return;
  }

  if (!(await isFeatureEnabled(admin, chatRow.id, NATURAL_GAME_FEATURE_KEY[intent.game]))) {
    await telegram.sendMessage(chatId, "Эта игра сейчас выключена в этом чате, сорян.");
    return;
  }
  const existingActive = await getActiveSession(admin, chatRow.id);
  if (existingActive) {
    await telegram.sendMessage(
      chatId,
      `Сейчас уже идёт «${GAME_LABELS[existingActive.type]}», закончите её сначала (/endgame).`,
    );
    return;
  }

  await telegram.sendMessage(
    chatId,
    `А вы точно хотите начать «${NATURAL_GAME_LABELS[intent.game]}»?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Го", callback_data: `ngc:sy:${NATURAL_GAME_CODE[intent.game]}` },
            { text: "❌ Не сейчас", callback_data: "ngc:sn" },
          ],
        ],
      },
    },
  );
}

/** Returns a follow-up message to send, or null when the game module already announced itself. */
async function startNaturalGame(
  admin: ReturnType<typeof getAdmin>,
  chatRow: { id: string },
  chatId: number,
  game: NaturalGameKey,
  invoker: { id: number; name: string },
): Promise<string | null> {
  const ctx: GameCtx = { admin, chatId: chatRow.id, telegramChatId: chatId, lang: "ru" };

  if (!(await isFeatureEnabled(admin, chatRow.id, NATURAL_GAME_FEATURE_KEY[game]))) {
    return "Эта игра сейчас выключена в этом чате, сорян.";
  }

  switch (game) {
    case "crocodile": {
      const r = await startCrocodile(ctx, invoker);
      return (r as any).alreadyActive
        ? "Уже идёт другая игра, закончите её сначала (/endgame)."
        : null;
    }
    case "taboo": {
      const r = await startTaboo(ctx, invoker);
      return (r as any).alreadyActive
        ? "Уже идёт другая игра, закончите её сначала (/endgame)."
        : null;
    }
    case "truth_or_dare": {
      const r = await startTruthOrDare(ctx, invoker);
      return (r as any).alreadyActive
        ? "Уже идёт другая игра, закончите её сначала (/endgame)."
        : null;
    }
    case "mafia": {
      const r = await startMafiaLobby(ctx, invoker);
      return (r as any).alreadyActive
        ? "Уже идёт другая игра, закончите её сначала (/endgame)."
        : null;
    }
    case "cringe": {
      const r = await startCringeGame(ctx, "cringe");
      if ((r as any).alreadyActive) return "Уже идёт другая игра, закончите её сначала (/endgame).";
      if ((r as any).noEntries)
        return "База кринжа пуста — накидайте цитат через /cringe в ответ на сообщение.";
      return null;
    }
    case "who_said": {
      const r = await startCringeGame(ctx, "who_said");
      if ((r as any).alreadyActive) return "Уже идёт другая игра, закончите её сначала (/endgame).";
      if ((r as any).noEntries)
        return "Мало цитат — отметь угар через /cringe в ответ на сообщение, или подожди пока бот наберёт из чата.";
      return null;
    }
    case "aiesec_quiz": {
      const r = await startAiesecQuiz(ctx);
      if ((r as any).alreadyActive)
        return "Уже идёт другая игра, закончите её сначала (/endgame).";
      return (r as any).noQuestions ? "Пока нет вопросов в базе квиза." : null;
    }
    case "meme_of_day": {
      const r = await startMemeOfDay(ctx);
      return (r as any).alreadyActive ? "Мем дня уже идёт!" : null;
    }
    case "archetype_quiz": {
      const r = await startArchetypeQuiz(ctx, invoker);
      if ((r as any).alreadyActive) return "Уже идёт другая игра, закончите её сначала (/endgame).";
      if ((r as any).noQuestions) return "Пока нет вопросов для теста.";
      return null;
    }
    case "two_truths": {
      let dmOk = false;
      try {
        await beginTwoTruthsDialog(admin, invoker.id, chatRow.id);
        dmOk = true;
      } catch {
        // no-op: fall through to the deep-link fallback below
      }
      if (!dmOk) {
        const link = await buildDeepLink(`tt_${chatRow.id}`);
        return `${invoker.name}, не смог написать в личку 😅 ${link ? `Открой: ${link} и жми /start` : "Напиши мне /start в личке."}`;
      }
      return `${invoker.name}, я написал тебе в личку — заполняй свои 3 факта там 📩`;
    }
    case "red_button": {
      const r = await startRedButton(ctx, invoker);
      return (r as any).alreadyActive
        ? "Уже идёт другая игра, закончите её сначала (/endgame)."
        : null;
    }
    case "excuse_duel": {
      const r = await startExcuseDuel(ctx);
      if ((r as any).alreadyActive) return "Уже идёт другая игра, закончите её сначала (/endgame).";
      if ((r as any).notEnough)
        return "Маловато активных участников для дуэли — нужно хотя бы двое, кто недавно писал.";
      return null;
    }
    case "quiz_duel": {
      const r = await startQuizDuel(ctx, invoker);
      if ((r as any).alreadyActive) return "Уже идёт другая игра, закончите её сначала (/endgame).";
      if ((r as any).notEnough) return "Маловато вопросов в базе квиза для дуэли.";
      return null;
    }
    default:
      return "Хм, не понял какую игру запускать.";
  }
}

// ── callback_query dispatch ─────────────────────────────────────────────

async function handleCallbackQuery(admin: ReturnType<typeof getAdmin>, cb: any) {
  const data: string = cb.data ?? "";
  const fromUser: TgUser = cb.from;
  const fromName = tgDisplayName(fromUser);

  if (data.startsWith("feat:")) {
    await handleFeaturesCallback(admin, cb, data);
    return;
  }

  if (data.startsWith("ship_toggle:")) {
    const chatUuid = data.split(":")[1];
    const { data: member } = await admin
      .from("chat_members")
      .select("shipping_opt_in")
      .eq("chat_id", chatUuid)
      .eq("telegram_user_id", fromUser.id)
      .maybeSingle();
    const next = !(member?.shipping_opt_in ?? false);
    await admin
      .from("chat_members")
      .update({ shipping_opt_in: next })
      .eq("chat_id", chatUuid)
      .eq("telegram_user_id", fromUser.id);
    const msgId = cb.message?.message_id;
    const chatTelegramId = cb.message?.chat?.id;
    if (msgId && chatTelegramId) {
      await telegram.editMessageText(
        chatTelegramId,
        msgId,
        next
          ? "💘 Ты в шипперинге! Бот может подкинуть тебя в пару когда угодно."
          : "🚫 Ты вышел из шипперинга. Можно вернуться кнопкой ниже или /ship_optin",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: next ? "🚫 Не участвую" : "✅ Участвую",
                  callback_data: `ship_toggle:${chatUuid}`,
                },
              ],
            ],
          },
        },
      );
    }
    await telegram.answerCallbackQuery(cb.id, next ? "Участвуешь 💘" : "Вышел из шипа");
    return;
  }

  if (data.startsWith("tumba_reply:") || data.startsWith("ama_reply:")) {
    const chatUuid = data.split(":")[1];
    const isAma = data.startsWith("ama_reply:");
    try {
      await beginTumbaDialog(admin, fromUser.id, chatUuid, isAma ? "ama" : undefined);
      await telegram.answerCallbackQuery(cb.id, "Написал в личку ✉️");
    } catch {
      const link = await buildDeepLink(`${isAma ? "ama" : "tumba"}_${chatUuid}`);
      await telegram.answerCallbackQuery(cb.id, "Открой личку с ботом", true);
      if (link) await telegram.sendMessage(cb.message.chat.id, `Открой: ${link}`);
    }
    return;
  }

  if (data.startsWith("ama_skip:")) {
    await telegram.answerCallbackQuery(cb.id, "Ок, пропускаем");
    if (cb.message?.message_id && cb.message?.chat?.id) {
      await telegram.editMessageReplyMarkup(cb.message.chat.id, cb.message.message_id, undefined);
    }
    return;
  }

  if (data.startsWith("tumba_cat:")) {
    await handleTumbaCategoryChoice(admin, fromUser.id, data.split(":")[1] as TumbaCategory);
    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  if (data.startsWith("tt_lie:")) {
    const idx = Number(data.split(":")[1]);
    const { data: dialog } = await admin
      .from("bot_dialogs")
      .select("*")
      .eq("telegram_user_id", fromUser.id)
      .maybeSingle();
    if (dialog?.kind === "two_truths_submit" && dialog.state.step === "lie") {
      await finalizeTwoTruths(admin, dialog, idx, fromName);
    }
    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  if (data.startsWith("shop_buy:")) {
    await handleShopBuy(admin, cb, data.split(":")[1]);
    return;
  }

  if (data.startsWith("ngc:")) {
    await handleNaturalGameCallback(admin, cb, data, fromUser, fromName);
    return;
  }

  const parsed = parseCallback(data);
  if (!parsed) {
    await telegram.answerCallbackQuery(cb.id);
    return;
  }
  const session = await getSessionByShortCode(admin, parsed.shortCode);
  if (!session || session.status === "finished" || session.status === "cancelled") {
    await telegram.answerCallbackQuery(cb.id, "Игра уже закончилась.", true);
    return;
  }
  const { data: chatRow } = await admin
    .from("chats")
    .select("telegram_chat_id")
    .eq("id", session.chat_id)
    .maybeSingle();
  if (!chatRow) {
    await telegram.answerCallbackQuery(cb.id);
    return;
  }
  const ctx: GameCtx = {
    admin,
    chatId: session.chat_id,
    telegramChatId: chatRow.telegram_chat_id,
    lang: "ru",
  };
  scheduleDueTicks(admin, session.chat_id);

  switch (session.type) {
    case "crocodile":
      await handleCrocodileCallback(ctx, session, parsed.action, cb.id, fromUser.id);
      break;
    case "aiesec_quiz":
      await handleAiesecQuizCallback(
        ctx,
        session,
        parsed.action,
        parsed.payload,
        cb.id,
        fromUser.id,
      );
      break;
    case "cringe":
      await handleCringeCallback(ctx, session, parsed.action, parsed.payload, cb.id, fromUser.id);
      break;
    case "two_truths":
      await handleTwoTruthsCallback(
        ctx,
        session,
        parsed.action,
        parsed.payload,
        cb.id,
        fromUser.id,
      );
      break;
    case "mafia":
      await handleMafiaCallback(ctx, session, parsed.action, parsed.payload, cb.id, {
        id: fromUser.id,
        name: fromName,
      });
      break;
    case "taboo":
      await handleTabooCallback(ctx, session, parsed.action, parsed.payload, cb.id, {
        id: fromUser.id,
        name: fromName,
      });
      break;
    case "truth_or_dare":
      await handleTruthOrDareCallback(
        ctx,
        session,
        parsed.action,
        parsed.payload,
        cb.id,
        fromUser.id,
        fromName,
      );
      break;
    case "meme_of_day":
      await handleMemeCallback(ctx, session, parsed.action, parsed.payload, cb.id, fromUser.id);
      break;
    case "totalizator":
      await handleTotalizatorCallback(
        ctx,
        session,
        parsed.action,
        parsed.payload,
        cb.id,
        fromUser.id,
      );
      break;
    case "archetype_quiz":
      await handleArchetypeCallback(
        ctx,
        session,
        parsed.action,
        parsed.payload,
        cb.id,
        fromUser.id,
      );
      break;
    case "red_button":
      await handleRedButtonCallback(ctx, session, parsed.action, parsed.payload, cb.id, {
        id: fromUser.id,
        name: fromName,
      });
      break;
    case "excuse_duel":
      await handleExcuseDuelCallback(
        ctx,
        session,
        parsed.action,
        parsed.payload,
        cb.id,
        fromUser.id,
      );
      break;
    case "quiz_duel":
      await handleQuizDuelCallback(ctx, session, parsed.action, parsed.payload, cb.id, {
        id: fromUser.id,
        name: fromName,
      });
      break;
    default:
      await telegram.answerCallbackQuery(cb.id);
  }
}

async function handleNaturalGameCallback(
  admin: ReturnType<typeof getAdmin>,
  cb: any,
  data: string,
  fromUser: TgUser,
  fromName: string,
) {
  const chatTelegramId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (!chatTelegramId || !messageId) {
    await telegram.answerCallbackQuery(cb.id);
    return;
  }
  const { data: chatRow } = await admin
    .from("chats")
    .select("id")
    .eq("telegram_chat_id", chatTelegramId)
    .maybeSingle();
  if (!chatRow) {
    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  const parts = data.split(":");
  const action = parts[1]; // sy | sn | ey | en

  if (action === "sn") {
    await telegram.editMessageText(chatTelegramId, messageId, "Окей, отбой 🤙");
    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  if (action === "en") {
    await telegram.editMessageText(chatTelegramId, messageId, "Окей, продолжаем игру 👍");
    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  if (action === "ey") {
    if (!(await isTelegramChatAdmin(chatTelegramId, fromUser.id))) {
      await telegram.answerCallbackQuery(
        cb.id,
        "Только админ чата (EB) может это подтвердить.",
        true,
      );
      return;
    }
    const active = await getActiveSession(admin, chatRow.id);
    if (!active) {
      await telegram.editMessageText(chatTelegramId, messageId, "Игра уже не активна.");
      await telegram.answerCallbackQuery(cb.id);
      return;
    }
    await cancelSession(admin, active.id);
    await telegram.editMessageText(
      chatTelegramId,
      messageId,
      `Игра «${GAME_LABELS[active.type]}» прервана 🛑`,
    );
    await telegram.answerCallbackQuery(cb.id, "Прервано!");
    return;
  }

  if (action === "sy") {
    const code = parts[2];
    const game = NATURAL_CODE_TO_GAME[code];
    if (!game) {
      await telegram.answerCallbackQuery(cb.id);
      return;
    }
    await telegram.answerCallbackQuery(cb.id, "Го!");
    await telegram.editMessageText(chatTelegramId, messageId, "Го, начинаем 🤙");
    await telegram.sendChatAction(chatTelegramId, "typing");
    const resultText = await startNaturalGame(admin, chatRow, chatTelegramId, game, {
      id: fromUser.id,
      name: fromName,
    });
    if (resultText) await telegram.sendMessage(chatTelegramId, resultText);
    return;
  }

  await telegram.answerCallbackQuery(cb.id);
}

async function handleShopBuy(admin: ReturnType<typeof getAdmin>, cb: any, itemKey: string) {
  const fromUser: TgUser = cb.from;
  const chatTelegramId = cb.message?.chat?.id;
  if (!chatTelegramId) {
    await telegram.answerCallbackQuery(cb.id);
    return;
  }

  let chatRow: { id: string } | null = null;
  if (cb.message?.chat?.type === "private") {
    const resolved = await resolveSingleChatForUser(admin, fromUser.id);
    if (resolved && resolved !== "multiple") chatRow = resolved;
  } else {
    const { data } = await admin
      .from("chats")
      .select("id")
      .eq("telegram_chat_id", chatTelegramId)
      .maybeSingle();
    chatRow = data;
  }

  if (!chatRow) {
    await telegram.answerCallbackQuery(cb.id, "Не нашёл твой чат для покупки.", true);
    return;
  }

  if (itemKey === "mafia_immunity") {
    const ok = await applyMafiaImmunityPurchase(admin, chatRow.id, fromUser.id);
    await telegram.answerCallbackQuery(
      cb.id,
      ok ? "Иммунитет куплен! 🛡" : "Недостаточно БешКоинов.",
      true,
    );
    return;
  }
  if (itemKey === "roast") {
    await telegram.answerCallbackQuery(
      cb.id,
      "Используй /roast @username (ответь на сообщение) — спишется 50 коинов.",
      true,
    );
    return;
  }
  if (itemKey === "coin_gift") {
    await telegram.answerCallbackQuery(cb.id, "Используй /gift @username сумма", true);
    return;
  }
  if (itemKey === "tumba_boost") {
    const ok = await spendCoins(admin, chatRow.id, fromUser.id, 30, { item: "tumba_boost" });
    if (!ok) {
      await telegram.answerCallbackQuery(cb.id, "Недостаточно БешКоинов.", true);
      return;
    }
    const { data: pending } = await admin
      .from("tumba_messages")
      .select("*")
      .eq("chat_id", chatRow.id)
      .eq("from_telegram_user_id", fromUser.id)
      .eq("status", "approved")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pending) {
      const { data: groupChat } = await admin
        .from("chats")
        .select("telegram_chat_id")
        .eq("id", chatRow.id)
        .maybeSingle();
      if (groupChat?.telegram_chat_id) {
        await telegram.sendMessage(groupChat.telegram_chat_id, `🚀 <b>Буст сахарка!</b>\n${pending.body}`);
      }
      await admin
        .from("tumba_messages")
        .update({ status: "posted", posted_at: new Date().toISOString() })
        .eq("id", pending.id);
    }
    await telegram.answerCallbackQuery(cb.id, "Забустил! 🚀");
    return;
  }
  if (itemKey === "custom_title") {
    const ok = await spendCoins(admin, chatRow.id, fromUser.id, 40, { item: "custom_title" });
    await telegram.answerCallbackQuery(
      cb.id,
      ok ? "Куплено! Напиши EB, каким титулом тебя звать 😎" : "Недостаточно БешКоинов.",
      true,
    );
    return;
  }
  await telegram.answerCallbackQuery(cb.id);
}

// ── private (DM) message handling ────────────────────────────────────────

async function handlePrivateMessage(admin: ReturnType<typeof getAdmin>, message: TgMessage) {
  const telegramUserId = message.from!.id;
  const text = message.text ?? "";
  const lang = detectLanguage(text, message.from?.language_code);
  const fromName = tgDisplayName(message.from);

  if (text.startsWith("/start")) {
    const payload = text.split(" ")[1];
    if (!payload) {
      await sendDmWithMenu(telegramUserId, `Привет, ${fromName}! 🤙\n\nЛичное меню внизу — жми кнопки. В группе меня тегай или пиши команды.`);
      return;
    }
    const sep = payload.indexOf("_");
    const prefix = sep === -1 ? payload : payload.slice(0, sep);
    const ref = sep === -1 ? "" : payload.slice(sep + 1);

    if (prefix === "mafia" || prefix === "croc" || prefix === "taboo") {
      const session = await getSessionByShortCode(admin, ref);
      if (!session) {
        await telegram.sendMessage(telegramUserId, "Игра не найдена или уже закончилась.");
        return;
      }
      if (prefix === "mafia") await resendMafiaRole(admin, session, telegramUserId);
      if (prefix === "croc") await resendCrocodileWord(admin, session, telegramUserId);
      if (prefix === "taboo") await resendTabooCard(admin, session, telegramUserId);
      return;
    }
    if (prefix === "tt") {
      await beginTwoTruthsDialog(admin, telegramUserId, ref);
      return;
    }
    if (prefix === "tumba" || prefix === "ama") {
      await beginTumbaDialog(admin, telegramUserId, ref, prefix === "ama" ? "ama" : undefined);
      return;
    }
    await sendDmWithMenu(telegramUserId, T.help[lang]);
    return;
  }

  if (DM_MENU_TEXTS.has(text)) {
    await handleDmMenuAction(admin, telegramUserId, text, lang);
    return;
  }

  if (text.startsWith("/tumba") || text.startsWith("/ama") || text.startsWith("/two_truths")) {
    const chat = await resolveSingleChatForUser(admin, telegramUserId);
    if (chat === null) {
      await telegram.sendMessage(
        telegramUserId,
        "Сначала напиши что-нибудь в общем чате локалки, чтобы я тебя знал 🙂",
      );
      return;
    }
    if (chat === "multiple") {
      await telegram.sendMessage(
        telegramUserId,
        "Ты состоишь в нескольких чатах со мной — запусти команду прямо в нужном групповом чате.",
      );
      return;
    }
    if (text.startsWith("/two_truths")) await beginTwoTruthsDialog(admin, telegramUserId, chat.id);
    else
      await beginTumbaDialog(
        admin,
        telegramUserId,
        chat.id,
        text.startsWith("/ama") ? "ama" : undefined,
      );
    return;
  }

  const { data: dialog } = await admin
    .from("bot_dialogs")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  if (text.trim() && (await handleTabooPrivateMessage(admin, telegramUserId, text))) {
    return;
  }

  if (dialog && text.trim()) {
    if (dialog.kind === "two_truths_submit") {
      const consumed = await handleTwoTruthsDialogMessage(admin, dialog, text, fromName);
      if (consumed) return;
    }
    if (dialog.kind === "tumba_compose") {
      const consumed = await handleTumbaDialogMessage(admin, dialog, text);
      if (consumed) return;
    }
  }

  await sendDmWithMenu(telegramUserId, T.help[lang]);
}

// ── group message handling ───────────────────────────────────────────────

async function handleGroupMessage(admin: ReturnType<typeof getAdmin>, message: TgMessage) {
  const chatId = message.chat.id;
  const text = message.text ?? "";

  const chatRow = await ensureChat(admin, message.chat);
  if (!chatRow) return;
  scheduleDueTicks(admin, chatRow.id);
  await admin
    .from("chats")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", chatRow.id);

  const { data: settings } = await admin
    .from("bot_settings")
    .select("*")
    .eq("chat_id", chatRow.id)
    .maybeSingle();
  const lang: Lang = resolveLang(settings?.language, text, message.from?.language_code);
  const fromName = tgDisplayName(message.from);

  if (settings?.is_paused) return;

  if (message.from && !message.from.is_bot) {
    await ensureMember(admin, chatRow.id, message.from.id, {
      username: message.from.username,
      display_name: fromName,
    });
  }

  const ctx: GameCtx = { admin, chatId: chatRow.id, telegramChatId: chatId, lang };
  const botUsername = await import("@/lib/telegram.server").then((m) => m.getBotUsername());

  // Active game consumes plain (non-command) messages before anything else.
  const activeGame = await getActiveSession(admin, chatRow.id);
  if (activeGame && !text.startsWith("/")) {
    if (activeGame.type === "crocodile") {
      if (await handleCrocodileMessage(ctx, activeGame, message)) return;
    } else if (activeGame.type === "taboo") {
      if (await handleTabooMessage(ctx, activeGame, message)) return;
    } else if (activeGame.type === "meme_of_day") {
      if (await handleMemeMessage(ctx, activeGame, message as any, fromName)) return;
    }
  }

  if (text.startsWith("/")) {
    const cmd = text.split(/\s|@/)[0].toLowerCase();
    const rest = text.slice(cmd.length).trim();

    if (cmd === "/start" || cmd === "/help") {
      await telegram.sendMessage(chatId, T.help[lang]);
      return;
    }
    if (cmd === "/features" || cmd === "/функции") {
      const map = await getFeatureMap(admin, chatRow.id);
      await telegram.sendMessage(chatId, featuresRootText(map), {
        reply_markup: buildFeaturesRootKeyboard(),
      });
      return;
    }
    if (cmd === "/icebreaker") {
      if (!(settings?.prompts_enabled ?? true)) return;
      const { data: allPrompts } = await admin
        .from("prompts")
        .select("text,language")
        .eq("is_active", true);
      const filtered = (allPrompts ?? []).filter((p: any) => p.language === lang);
      const pool = filtered.length > 0 ? filtered : (allPrompts ?? []);
      const prompt = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)].text : null;
      if (prompt) {
        await telegram.sendMessage(chatId, `${T.icebreakerLabel[lang]}\n${prompt}`);
        await admin
          .from("bot_sends")
          .insert({ telegram_chat_id: chatId, kind: "prompt", content: prompt });
      }
      return;
    }
    if (cmd === "/poll") {
      if (!(settings?.polls_enabled ?? true)) return;
      const parts = rest
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length < 3) {
        await telegram.sendMessage(chatId, T.pollUsage[lang]);
        return;
      }
      const [question, ...options] = parts;
      try {
        const res: any = await telegram.sendPoll(chatId, question, options.slice(0, 10));
        await admin.from("polls").insert({
          telegram_chat_id: chatId,
          telegram_poll_id: res?.result?.poll?.id ?? null,
          telegram_message_id: res?.result?.message_id ?? null,
          question,
          options: options.slice(0, 10),
          kind: "poll",
        });
        await admin
          .from("bot_sends")
          .insert({ telegram_chat_id: chatId, kind: "poll", content: question });
      } catch (e: any) {
        await telegram.sendMessage(chatId, `${T.pollFailed[lang]}${e.message}`);
      }
      return;
    }
    if (cmd === "/trivia") {
      if (!(settings?.polls_enabled ?? true)) return;
      try {
        const key = process.env.DEEPSEEK_API_KEY!;
        const provider = createDeepSeekProvider(key);
        const { text: raw } = await generateText({
          model: provider(getDeepSeekModel()),
          system: T.triviaPrompt[lang],
          prompt:
            lang === "ru" ? "Сгенерируй один вопрос викторины." : "Generate one trivia question.",
        });
        const cleaned = raw.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(cleaned);
        const res: any = await telegram.sendPoll(chatId, `🎯 ${parsed.question}`, parsed.options, {
          type: "quiz",
          correct_option_id: parsed.correct,
          is_anonymous: false,
        });
        await admin.from("polls").insert({
          telegram_chat_id: chatId,
          telegram_poll_id: res?.result?.poll?.id ?? null,
          telegram_message_id: res?.result?.message_id ?? null,
          question: parsed.question,
          options: parsed.options,
          correct_option: parsed.correct,
          kind: "trivia",
        });
        await admin
          .from("bot_sends")
          .insert({ telegram_chat_id: chatId, kind: "trivia", content: parsed.question });
      } catch (e: any) {
        console.error(e);
        await telegram.sendMessage(chatId, T.triviaFailed[lang]);
      }
      return;
    }

    if (cmd === "/pause" || cmd === "/unpause") {
      if (!message.from || !(await isTelegramChatAdmin(chatId, message.from.id))) {
        await telegram.sendMessage(chatId, "Эта команда только для админов чата (EB).");
        return;
      }
      await admin
        .from("bot_settings")
        .update({ is_paused: cmd === "/pause" })
        .eq("id", settings?.id);
      await telegram.sendMessage(
        chatId,
        cmd === "/pause" ? "Молчу-молчу 🤐 (/unpause чтобы вернуть)" : "Я снова тут! 🎉",
      );
      return;
    }

    if (cmd === "/endgame") {
      if (!message.from || !(await isTelegramChatAdmin(chatId, message.from.id))) {
        await telegram.sendMessage(chatId, "Прервать игру может только админ чата (EB).");
        return;
      }
      const active = await getActiveSession(admin, chatRow.id);
      if (!active) {
        await telegram.sendMessage(chatId, "Сейчас нет активной игры.");
        return;
      }
      await cancelSession(admin, active.id);
      await telegram.sendMessage(chatId, `Игра «${GAME_LABELS[active.type]}» прервана 🛑`);
      return;
    }
    if (cmd === "/crocodile" && (await isFeatureEnabled(admin, chatRow.id, "crocodile"))) {
      const r = await startCrocodile(ctx, { id: message.from!.id, name: fromName });
      if ((r as any).alreadyActive)
        await telegram.sendMessage(
          chatId,
          "Сейчас уже идёт другая игра, закончите её сначала (или EB может прервать через /endgame).",
        );
      return;
    }
    if (cmd === "/taboo" && (await isFeatureEnabled(admin, chatRow.id, "taboo"))) {
      const r = await startTaboo(ctx, { id: message.from!.id, name: fromName });
      if ((r as any).alreadyActive)
        await telegram.sendMessage(
          chatId,
          "Сейчас уже идёт другая игра, закончите её сначала (или EB может прервать через /endgame).",
        );
      return;
    }
    if (
      (cmd === "/truth_or_dare" || cmd === "/pod") &&
      (await isFeatureEnabled(admin, chatRow.id, "truth_or_dare"))
    ) {
      const r = await startTruthOrDare(ctx, { id: message.from!.id, name: fromName });
      if ((r as any).alreadyActive)
        await telegram.sendMessage(
          chatId,
          "Сейчас уже идёт другая игра, закончите её сначала (или EB может прервать через /endgame).",
        );
      return;
    }
    if (cmd === "/mafia" && (await isFeatureEnabled(admin, chatRow.id, "mafia"))) {
      const r = await startMafiaLobby(ctx, { id: message.from!.id, name: fromName });
      if ((r as any).alreadyActive)
        await telegram.sendMessage(
          chatId,
          "Сейчас уже идёт другая игра, закончите её сначала (или EB может прервать через /endgame).",
        );
      return;
    }
    if (cmd === "/cringe") {
      if (!message.reply_to_message?.from) {
        await telegram.sendMessage(
          chatId,
          "Ответь этой командой на сообщение, которое хочешь занести в базу кринжа.",
        );
        return;
      }
      await admin.from("cringe_entries").insert({
        chat_id: chatRow.id,
        quote_text: message.reply_to_message.text ?? "(медиа-сообщение)",
        telegram_user_id: message.reply_to_message.from.id,
        source_message_id: message.reply_to_message.message_id,
        added_by_user_id: message.from!.id,
        pool: "shared",
      });
      await telegram.sendMessage(
        chatId,
        "Занесено в базу цитат 📼 (пойдёт в «Кто это сказал» и кринж-игру).",
      );
      return;
    }
    if (
      (cmd === "/whothis" || cmd === "/cringe_game") &&
      (await isFeatureEnabled(admin, chatRow.id, "cringe"))
    ) {
      const r = await startCringeGame(ctx, "cringe");
      if ((r as any).alreadyActive)
        await telegram.sendMessage(
          chatId,
          "Сейчас уже идёт другая игра, закончите её сначала (или EB может прервать через /endgame).",
        );
      if ((r as any).noEntries)
        await telegram.sendMessage(
          chatId,
          "База кринжа пуста — накидайте цитат через /cringe в ответ на сообщение.",
        );
      return;
    }
    if (cmd === "/who_said" && (await isFeatureEnabled(admin, chatRow.id, "who_said_this"))) {
      const r = await startCringeGame(ctx, "who_said");
      if ((r as any).alreadyActive)
        await telegram.sendMessage(
          chatId,
          "Сейчас уже идёт другая игра, закончите её сначала (или EB может прервать через /endgame).",
        );
      if ((r as any).noEntries)
        await telegram.sendMessage(
          chatId,
          "Мало цитат — отметь угар через /cringe в ответ на сообщение, или подожди пока бот наберёт из чата.",
        );
      return;
    }
    if (
      (cmd === "/quiz" || cmd === "/aiesec_quiz") &&
      (await isFeatureEnabled(admin, chatRow.id, "aiesec_quiz"))
    ) {
      const r = await startAiesecQuiz(ctx);
      if ((r as any).noQuestions)
        await telegram.sendMessage(chatId, "Пока нет вопросов в базе квиза.");
      return;
    }
    if (cmd === "/two_truths" && (await isFeatureEnabled(admin, chatRow.id, "two_truths"))) {
      let dmOk = false;
      try {
        await beginTwoTruthsDialog(admin, message.from!.id, chatRow.id);
        dmOk = true;
      } catch {
        // no-op: fall through to the deep-link fallback below
      }
      if (!dmOk) {
        const link = await buildDeepLink(`tt_${chatRow.id}`);
        await telegram.sendMessage(
          chatId,
          `${fromName}, не смог написать в личку 😅 ${link ? `Открой: ${link} и жми /start` : "Напиши мне /start в личке."}`,
        );
      }
      return;
    }
    if (cmd === "/meme_of_day" && (await isFeatureEnabled(admin, chatRow.id, "meme_of_day"))) {
      const r = await startMemeOfDay(ctx);
      if ((r as any).alreadyActive) await telegram.sendMessage(chatId, "Мем дня уже идёт!");
      return;
    }
    if (cmd === "/bet" && (await isFeatureEnabled(admin, chatRow.id, "totalizator"))) {
      const parts = rest
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length < 3) {
        await telegram.sendMessage(
          chatId,
          "Использование: /bet Вопрос | Вариант 1 | Вариант 2 | ...",
        );
        return;
      }
      const [question, ...options] = parts;
      const r = await startTotalizator(ctx, question, options.slice(0, 6), message.from!.id);
      if ((r as any).alreadyActive) await telegram.sendMessage(chatId, "Тотализатор уже идёт!");
      return;
    }
    if (cmd === "/bet_resolve") {
      if (!message.from || !(await isTelegramChatAdmin(chatId, message.from.id))) {
        await telegram.sendMessage(chatId, "Разрешить тотализатор может только админ чата.");
        return;
      }
      const idx = Number(rest.trim());
      if (Number.isNaN(idx)) {
        await telegram.sendMessage(
          chatId,
          "Использование: /bet_resolve <номер варианта, начиная с 0>",
        );
        return;
      }
      const r = await resolveTotalizator(ctx, idx);
      if ((r as any).noActive) await telegram.sendMessage(chatId, "Нет активного тотализатора.");
      return;
    }
    if (cmd === "/archetype" && (await isFeatureEnabled(admin, chatRow.id, "archetype_quiz"))) {
      const r = await startArchetypeQuiz(ctx, { id: message.from!.id, name: fromName });
      if ((r as any).alreadyActive)
        await telegram.sendMessage(
          chatId,
          "Сейчас уже идёт другая игра, закончите её сначала (или EB может прервать через /endgame).",
        );
      if ((r as any).noQuestions)
        await telegram.sendMessage(chatId, "Пока нет вопросов для теста.");
      return;
    }
    if (
      (cmd === "/redbutton" || cmd === "/red_button" || cmd === "/knopka") &&
      (await isFeatureEnabled(admin, chatRow.id, "red_button"))
    ) {
      const r = await startRedButton(ctx, { id: message.from!.id, name: fromName });
      if ((r as any).alreadyActive)
        await telegram.sendMessage(
          chatId,
          "Сейчас уже идёт другая игра, закончите её сначала (или EB может прервать через /endgame).",
        );
      return;
    }
    if (
      (cmd === "/excuse_duel" || cmd === "/duel_excuse") &&
      (await isFeatureEnabled(admin, chatRow.id, "excuse_duel"))
    ) {
      const r = await startExcuseDuel(ctx);
      if ((r as any).alreadyActive)
        await telegram.sendMessage(
          chatId,
          "Сейчас уже идёт другая игра, закончите её сначала (или EB может прервать через /endgame).",
        );
      if ((r as any).notEnough)
        await telegram.sendMessage(
          chatId,
          "Маловато активных участников для дуэли — нужно хотя бы двое, кто недавно писал.",
        );
      return;
    }
    if (cmd === "/duel" && (await isFeatureEnabled(admin, chatRow.id, "quiz_duel"))) {
      const r = await startQuizDuel(ctx, { id: message.from!.id, name: fromName });
      if ((r as any).alreadyActive)
        await telegram.sendMessage(
          chatId,
          "Сейчас уже идёт другая игра, закончите её сначала (или EB может прервать через /endgame).",
        );
      if ((r as any).notEnough)
        await telegram.sendMessage(chatId, "Маловато вопросов в базе квиза для дуэли.");
      return;
    }
    if (cmd === "/prediction" && (await isFeatureEnabled(admin, chatRow.id, "prediction"))) {
      await telegram.sendChatAction(chatId, "typing");
      const targets = await resolvePredictionTargets(
        admin,
        chatRow.id,
        message.reply_to_message?.from,
        rest,
      );
      const { intro, text } = await generatePrediction({
        admin,
        chatId: chatRow.id,
        invoker: predictionMemberFromTg(message.from!),
        targets: targets.length ? targets : undefined,
      });
      await telegram.sendMessage(chatId, `${intro}\n${text}`);
      return;
    }
    if (cmd === "/checkin" && (await isFeatureEnabled(admin, chatRow.id, "checkin"))) {
      const r = await startCheckin(admin, chatRow.id, chatId);
      if ((r as any).alreadyActive)
        await telegram.sendMessage(chatId, "Чекин уже идёт — дождись эстафеты или ответов.");
      if ((r as any).noMembers)
        await telegram.sendMessage(chatId, "Пока нет мемберов в базе для чекина.");
      return;
    }
    if (cmd === "/excuse" && (await isFeatureEnabled(admin, chatRow.id, "excuse"))) {
      const excuse = await generateExcuse(lang);
      await telegram.sendMessage(chatId, excuse);
      return;
    }
    if (cmd === "/roast") {
      const targetUser = message.reply_to_message?.from;
      if (!targetUser) {
        await telegram.sendMessage(
          chatId,
          "Ответь этой командой на сообщение мембера, которого роастим (спишется 50 БешКоинов).",
        );
        return;
      }
      const ok = await spendCoins(admin, chatRow.id, message.from!.id, 50, {
        item: "roast",
        target: targetUser.id,
      });
      if (!ok) {
        await telegram.sendMessage(chatId, "Недостаточно БешКоинов (нужно 50). Проверь /balance.");
        return;
      }
      const roast = await generateRoast(tgDisplayName(targetUser), lang);
      await telegram.sendMessage(chatId, roast);
      return;
    }
    if (cmd === "/gift") {
      const parts = rest.split(/\s+/).filter(Boolean);
      const targetUsername = parts[0]?.replace(/^@/, "");
      const amount = Number(parts[1]);
      if (!targetUsername || !Number.isFinite(amount) || amount <= 0) {
        await telegram.sendMessage(chatId, "Использование: /gift @username сумма");
        return;
      }
      const { data: targetMember } = await admin
        .from("chat_members")
        .select("telegram_user_id")
        .eq("chat_id", chatRow.id)
        .eq("username", targetUsername)
        .maybeSingle();
      if (!targetMember) {
        await telegram.sendMessage(
          chatId,
          "Не нашёл этого мембера в базе — пусть сначала что-то напишет в чат.",
        );
        return;
      }
      const ok = await spendCoins(admin, chatRow.id, message.from!.id, amount + 20, {
        item: "coin_gift",
        to: targetMember.telegram_user_id,
      });
      if (!ok) {
        await telegram.sendMessage(
          chatId,
          `Недостаточно БешКоинов (нужно ${amount + 20}, из них 20 — комиссия).`,
        );
        return;
      }
      await awardCoins(admin, chatRow.id, targetMember.telegram_user_id, amount, "vibe_gift", {
        from: message.from!.id,
      });
      await telegram.sendMessage(
        chatId,
        `${fromName} подарил(а) ${amount} БешКоинов @${targetUsername}! 🎁`,
      );
      return;
    }
    if (cmd === "/shop") {
      const { data: items } = await admin
        .from("shop_items")
        .select("*")
        .or(`chat_id.eq.${chatRow.id},chat_id.is.null`)
        .eq("is_active", true);
      if (!items || items.length === 0) {
        await telegram.sendMessage(chatId, "Магазин пуст.");
        return;
      }
      await telegram.sendMessage(
        chatId,
        `🛍 <b>Магазин Бешемека</b>\n${items.map((i) => `${i.title} — ${i.price} 🪙\n<i>${i.description ?? ""}</i>`).join("\n\n")}`,
        {
          reply_markup: buildShopBuyKeyboard(items),
        },
      );
      return;
    }
    if (cmd === "/balance") {
      const balance = await getBalance(admin, chatRow.id, message.from!.id);
      await telegram.sendMessage(chatId, `💰 У тебя ${balance} БешКоинов.`);
      return;
    }
    if (cmd === "/leaderboard") {
      const top = await getLeaderboard(admin, chatRow.id, 10);
      if (top.length === 0) {
        await telegram.sendMessage(chatId, "Лидерборд пуст.");
        return;
      }
      const lines = top.map(
        (m, i) =>
          `${i + 1}. ${m.display_name || (m.username ? `@${m.username}` : `#${m.telegram_user_id}`)} — ${m.coins} 🪙`,
      );
      await telegram.sendMessage(chatId, `🏆 <b>Лидерборд БешКоинов</b>\n${lines.join("\n")}`);
      return;
    }
    if (cmd === "/tumba" && (await isFeatureEnabled(admin, chatRow.id, "tumba"))) {
      await sendTumbaGroupReminder(chatId, chatRow.id, fromName);
      return;
    }
    if (cmd === "/ama" && (await isFeatureEnabled(admin, chatRow.id, "ama"))) {
      let dmOk = false;
      try {
        await beginTumbaDialog(admin, message.from!.id, chatRow.id, "ama");
        dmOk = true;
      } catch {
        // no-op: fall through to the deep-link fallback below
      }
      if (!dmOk) {
        const link = await buildDeepLink(`ama_${chatRow.id}`);
        await telegram.sendMessage(
          chatId,
          `${fromName}, напиши мне в личку 🎤 ${link ? `Открой: ${link} и жми /start` : ""}`,
        );
      }
      return;
    }
    if (cmd === "/ship_optout") {
      await admin
        .from("chat_members")
        .update({ shipping_opt_in: false })
        .eq("chat_id", chatRow.id)
        .eq("telegram_user_id", message.from!.id);
      await telegram.sendMessage(chatId, "🚫 Ты вышел из шипперинга.", {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Участвую",
                callback_data: `ship_toggle:${chatRow.id}`,
              },
            ],
          ],
        },
      });
      return;
    }
    if (cmd === "/ship_optin") {
      await admin
        .from("chat_members")
        .update({ shipping_opt_in: true })
        .eq("chat_id", chatRow.id)
        .eq("telegram_user_id", message.from!.id);
      await telegram.sendMessage(chatId, "💘 Ты в шипперинге! Бот может подкинуть тебя в пару.", {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🚫 Не участвую",
                callback_data: `ship_toggle:${chatRow.id}`,
              },
            ],
          ],
        },
      });
      return;
    }
    return; // unknown command, ignore
  }

  // «Тумба» / «сахарок» в группе — только напоминалка в личку.
  if (
    text &&
    !text.startsWith("/") &&
    (await isFeatureEnabled(admin, chatRow.id, "tumba")) &&
    looksLikeTumbaIntent(text)
  ) {
    await sendTumbaGroupReminder(chatId, chatRow.id, fromName);
    return;
  }

  // Active check-in: capture answers and relay to next member.
  if (text && message.from && !message.from.is_bot) {
    const handled = await handleCheckinMessage(
      admin,
      chatRow.id,
      chatId,
      message.from.id,
      text,
    );
    if (handled) return;
  }

  // Reactions on regular chat messages
  // occasionally drop a generic one (spec 1.3 / 8.2).
  if (text) {
    const triggerEmoji = pickTriggerReaction(text);
    if (
      triggerEmoji &&
      Math.random() < 0.35 &&
      (await isFeatureEnabled(admin, chatRow.id, "word_reactions"))
    ) {
      await telegram.setMessageReaction(chatId, message.message_id, triggerEmoji);
    } else if (Math.random() < 0.06) {
      await telegram.setMessageReaction(
        chatId,
        message.message_id,
        REACTION_EMOJI[Math.floor(Math.random() * REACTION_EMOJI.length)],
      );
    }
  }
  if (text && isCapsSpam(text) && Math.random() < 0.1) {
    const mash = resolveResponseMode("brainrot_capsmash").text;
    if (mash) await telegram.sendMessage(chatId, mash);
  }

  const mentionsBot =
    (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) ||
    message.reply_to_message?.from?.is_bot;

  if (mentionsBot && text.trim()) {
    const cleanTextForIntent = botUsername
      ? text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim()
      : text;

    // "What can you do / list your features" → show the features overview.
    if (
      /(что ты (умеешь|можешь)|какие( у тебя)? (функци|фичи|команд|возможност)|что умеешь|список (функц|команд|фич)|расскажи (о себе|про себя|что умеешь|какие функц)|твои функци|твои возможност|покажи (функц|команд|фич))/i.test(
        cleanTextForIntent,
      )
    ) {
      const map = await getFeatureMap(admin, chatRow.id);
      await telegram.sendMessage(chatId, buildFeaturesOverview(map));
      return;
    }

    const intent = detectGameIntent(cleanTextForIntent);
    if (intent && message.from) {
      await handleGameIntent(admin, chatRow, chatId, intent, {
        id: message.from.id,
        name: fromName,
      });
      return;
    }
  }

  if (mentionsBot && (settings?.ai_replies_enabled ?? true) && text.trim()) {
    const tone = settings?.tone ?? "Chill bro vibe, playful banter, never preachy.";
    const cleanText = botUsername
      ? text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim()
      : text;

    const chatHistory = await buildChatHistoryContext(admin, chatId);

    await telegram.sendChatAction(chatId, "typing");
    const reply = await generateAiReply(cleanText, tone, lang, chatHistory);
    await telegram.sendMessage(chatId, reply, { reply_to_message_id: message.message_id });
    await admin
      .from("bot_sends")
      .insert({ telegram_chat_id: chatId, kind: "ai_reply", content: reply });
    await admin
      .from("bot_settings")
      .update({ last_bot_message_at: new Date().toISOString() })
      .eq("id", settings?.id);
    return;
  }

  // Organic chime-in when chat is lively but bot wasn't mentioned.
  if (text && message.from && !message.from.is_bot && settings) {
    await tryOrganicChimeIn(admin, chatRow.id, chatId, {
      id: settings.id,
      last_bot_message_at: settings.last_bot_message_at,
      ai_replies_enabled: settings.ai_replies_enabled,
    });
  }
}

async function handleUpdate(update: any) {
  const admin = getAdmin();
  const message: TgMessage | undefined = update.message ?? update.edited_message;

  if (typeof update.update_id === "number") {
    await admin.from("messages_log").upsert(
      {
        update_id: update.update_id,
        telegram_chat_id: message?.chat?.id ?? 0,
        from_user_id: message?.from?.id ?? null,
        from_username: message?.from?.username ?? null,
        text: message?.text ?? null,
        kind: message?.text?.startsWith("/") ? "command" : "message",
        raw: update,
      },
      { onConflict: "update_id" },
    );
  }

  if (update.callback_query) {
    await handleCallbackQuery(admin, update.callback_query);
    return;
  }

  if (update.poll_answer) {
    await handlePollAnswer(admin, update.poll_answer);
    return;
  }

  if (update.my_chat_member) {
    const chat = update.my_chat_member.chat;
    const status = update.my_chat_member.new_chat_member?.status;
    const active = status === "member" || status === "administrator";
    const { data: existing } = await admin
      .from("chats")
      .select("id")
      .eq("telegram_chat_id", chat.id)
      .maybeSingle();
    if (existing) {
      await admin
        .from("chats")
        .update({ is_active: active, title: chat.title })
        .eq("id", existing.id);
    } else if (active) {
      const { data: inserted } = await admin
        .from("chats")
        .insert({
          telegram_chat_id: chat.id,
          title: chat.title,
          chat_type: chat.type,
          is_active: true,
        })
        .select("id")
        .single();
      if (inserted) {
        await admin.from("bot_settings").insert({ chat_id: inserted.id });
        const lang = detectLanguage(null, update.my_chat_member.from?.language_code);
        try {
          await telegram.sendMessage(chat.id, T.welcome[lang]);
          await admin
            .from("bot_sends")
            .insert({ telegram_chat_id: chat.id, kind: "welcome", content: "Welcome message" });
        } catch (e) {
          console.error(e);
        }
      }
    }
    return;
  }

  if (!message || !message.chat?.id) return;

  if (message.chat.type === "private") {
    if (!message.from || message.from.is_bot) return;
    await handlePrivateMessage(admin, message);
    return;
  }

  await handleGroupMessage(admin, message);
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!verifyTelegramSecret(request.headers.get("X-Telegram-Bot-Api-Secret-Token"))) {
          return new Response("Unauthorized", { status: 401 });
        }
        const update = await request.json();
        try {
          await handleUpdate(update);
        } catch (e) {
          // Always ack Telegram with 200 so it doesn't pile up retries; the
          // real error is logged server-side (visible in `wrangler tail`).
          console.error("webhook handler failed", e);
        }
        return Response.json({ ok: true });
      },
    },
  },
});
