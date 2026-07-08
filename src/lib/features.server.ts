import type { SupabaseClient } from "@supabase/supabase-js";

export type FeatureKey =
  | "mafia"
  | "crocodile"
  | "truth_or_dare"
  | "taboo"
  | "cringe"
  | "aiesec_quiz"
  | "excuse"
  | "two_truths"
  | "meme_of_day"
  | "totalizator"
  | "who_said_this"
  | "archetype_quiz"
  | "ama"
  | "tumba"
  | "shipping"
  | "random_triggers"
  | "economy"
  | "red_button"
  | "excuse_duel"
  | "quiz_duel"
  | "prediction"
  | "word_reactions"
  | "checkin";

export const ALL_FEATURE_KEYS: FeatureKey[] = [
  "mafia",
  "crocodile",
  "truth_or_dare",
  "taboo",
  "cringe",
  "aiesec_quiz",
  "excuse",
  "two_truths",
  "meme_of_day",
  "totalizator",
  "who_said_this",
  "archetype_quiz",
  "ama",
  "tumba",
  "shipping",
  "random_triggers",
  "economy",
  "red_button",
  "excuse_duel",
  "quiz_duel",
  "prediction",
  "word_reactions",
  "checkin",
];

/** Human-readable label + short description + how to trigger, per feature. */
export const FEATURE_INFO: Record<FeatureKey, { label: string; how: string }> = {
  mafia: { label: "🔪 Мафия", how: "/mafia или «го в мафию»" },
  crocodile: { label: "🐊 Крокодил", how: "/crocodile" },
  truth_or_dare: { label: "🎯 Правда или действие", how: "/truth_or_dare, /pod" },
  taboo: { label: "🚫 Табу", how: "/taboo" },
  cringe: { label: "😬 Кто этот Кринж", how: "/cringe (ответом на сообщение)" },
  aiesec_quiz: { label: "🧠 AIESEC квиз", how: "/quiz" },
  excuse: { label: "🙃 Генератор отмазок", how: "/excuse" },
  two_truths: { label: "🎭 Две правды и ложь", how: "/two_truths" },
  meme_of_day: { label: "🖼 Мем дня", how: "/meme_of_day" },
  totalizator: { label: "🎰 Тотализатор", how: "/bet Вопрос | Вариант1 | Вариант2" },
  who_said_this: { label: "🗯 Кто это сказал", how: "/who_said" },
  archetype_quiz: { label: "🧬 Архетип-тест", how: "/archetype" },
  ama: { label: "❓ AMA (анонимные вопросы)", how: "/ama" },
  tumba: { label: "🍬 Тумба (анонимки/сахарок)", how: "/tumba" },
  shipping: {
    label: "💘 Прогрессивный шиппинг",
    how: "сам по расписанию, /ship_optin /ship_optout",
  },
  random_triggers: {
    label: "🎲 Слежка за чатом (тишина + органичные вбросы)",
    how: "сам пишет при тишине 2–4ч и редко влезает в живой разговор",
  },
  economy: { label: "🪙 Экономика (БешКоины)", how: "/balance, /shop, /leaderboard, /gift" },
  red_button: { label: "💣 Красная кнопка", how: "/redbutton" },
  excuse_duel: { label: "🥊 Дуэль отмазок", how: "/excuse_duel" },
  quiz_duel: { label: "⚔️ Квиз-дуэль 1×1", how: "/duel" },
  prediction: { label: "🔮 Предсказание дня", how: "/predictions" },
  word_reactions: { label: "🔥 Реакции на слова-триггеры", how: "сам ставит эмодзи" },
  checkin: { label: "🧠 Чекины А/Б", how: "/checkin — дилеммы с тегами мемберов" },
};

/** Feature groups for inline /features menu. */
export const FEATURE_GROUPS: Array<{ id: string; title: string; keys: FeatureKey[] }> = [
  {
    id: "games",
    title: "🎮 Игры",
    keys: [
      "mafia",
      "crocodile",
      "taboo",
      "truth_or_dare",
      "cringe",
      "who_said_this",
      "aiesec_quiz",
      "two_truths",
      "meme_of_day",
      "archetype_quiz",
      "totalizator",
      "red_button",
      "excuse_duel",
      "quiz_duel",
    ],
  },
  { id: "economy", title: "🪙 Экономика", keys: ["economy"] },
  { id: "social", title: "🍬 Социальное", keys: ["tumba", "ama", "shipping"] },
  {
    id: "autopilot",
    title: "🤖 Автопилот и приколы",
    keys: ["random_triggers", "word_reactions", "prediction", "excuse", "checkin"],
  },
];

export function buildFeaturesCategoryText(
  map: Record<FeatureKey, boolean>,
  categoryId: string,
): string {
  const group = FEATURE_GROUPS.find((g) => g.id === categoryId);
  if (!group) return "Категория не найдена.";
  const lines = [
    `<b>${group.title}</b>`,
    "✅ включено / 🚫 выключено в этом чате:",
    "",
  ];
  for (const key of group.keys) {
    const info = FEATURE_INFO[key];
    const flag = map[key] ? "✅" : "🚫";
    lines.push(`${flag} ${info.label} — <code>${info.how}</code>`);
  }
  return lines.join("\n");
}

/** Builds the /features overview text showing what's on/off in a given chat. */
export function buildFeaturesOverview(map: Record<FeatureKey, boolean>): string {
  const lines: string[] = [
    "<b>Что я умею 🤙</b>",
    "Вот все мои функции (✅ включено / 🚫 выключено в этом чате):",
    "",
  ];
  for (const g of FEATURE_GROUPS) {
    lines.push(`<b>${g.title}</b>`);
    for (const key of g.keys) {
      const info = FEATURE_INFO[key];
      const flag = map[key] ? "✅" : "🚫";
      lines.push(`${flag} ${info.label} — <code>${info.how}</code>`);
    }
    lines.push("");
  }
  lines.push(
    "А ещё: тегни меня через @ или ответь на моё сообщение — поболтаем. Игры можно звать словами: «го в мафию», «бот, закончим игру».",
  );
  return lines.join("\n");
}

/** Features default to enabled unless a chat has an explicit row turning them off. */
export async function isFeatureEnabled(
  admin: SupabaseClient,
  chatId: string,
  key: FeatureKey,
): Promise<boolean> {
  const { data } = await admin
    .from("chat_features")
    .select("enabled")
    .eq("chat_id", chatId)
    .eq("feature_key", key)
    .maybeSingle();
  return data ? data.enabled : true;
}

export async function getFeatureMap(
  admin: SupabaseClient,
  chatId: string,
): Promise<Record<FeatureKey, boolean>> {
  const { data } = await admin
    .from("chat_features")
    .select("feature_key, enabled")
    .eq("chat_id", chatId);
  const overrides = new Map((data ?? []).map((r) => [r.feature_key, r.enabled]));
  const map = {} as Record<FeatureKey, boolean>;
  for (const key of ALL_FEATURE_KEYS) map[key] = overrides.has(key) ? !!overrides.get(key) : true;
  return map;
}

export async function setFeatureEnabled(
  admin: SupabaseClient,
  chatId: string,
  key: FeatureKey,
  enabled: boolean,
) {
  await admin
    .from("chat_features")
    .upsert({ chat_id: chatId, feature_key: key, enabled }, { onConflict: "chat_id,feature_key" });
}
