import { inlineKeyboard } from "@/lib/telegram.server";
import { FEATURE_INFO, FEATURE_GROUPS, type FeatureKey } from "@/lib/features.server";
import { formatMenuBtnLabel } from "@/lib/btn-label.server";

export type FeatureCategory = (typeof FEATURE_GROUPS)[number]["id"];

/** Categories shown in /features inline menu (autopilot excluded). */
export const FEATURE_MENU_CATEGORIES = ["games", "economy", "social"] as const satisfies readonly FeatureCategory[];

/** Menu item id — FeatureKey or economy sub-commands. */
export type FeatureMenuId =
  | FeatureKey
  | "balance"
  | "shop"
  | "leaderboard"
  | "gift";

export interface FeatureMenuItem {
  id: FeatureMenuId;
  label: string;
  featureKey: FeatureKey;
  desc: string;
  how: string;
  launchable: boolean;
}

const ECONOMY_ITEMS: FeatureMenuItem[] = [
  {
    id: "balance",
    label: "🪙 Баланс",
    featureKey: "economy",
    desc: "Сколько БешКоинов на счету.",
    how: "/balance",
    launchable: true,
  },
  {
    id: "shop",
    label: "🛍 Шоп",
    featureKey: "economy",
    desc: "Магазин плюшек за БешКоины.",
    how: "/shop",
    launchable: true,
  },
  {
    id: "leaderboard",
    label: "🏆 Топ",
    featureKey: "economy",
    desc: "Кто богаче всех в чате.",
    how: "/leaderboard",
    launchable: true,
  },
  {
    id: "gift",
    label: "🎁 Подарить",
    featureKey: "economy",
    desc: "Подарить коины другому мемберу.",
    how: "/gift @username сумма",
    launchable: false,
  },
];

const GAME_EXTRA: Partial<Record<FeatureKey, Partial<FeatureMenuItem>>> = {
  cringe: {
    desc: "Угадай, кто написал кринж — ответь /cringe на сообщение.",
    launchable: false,
  },
  who_said_this: {
    desc: "Угадай автора цитаты из последних ~250 сообщений чата (быстро, без AI). /cringe — вручную.",
    how: "/who_said",
    launchable: true,
  },
  totalizator: {
    desc: "Ставки на исход — нужен вопрос и варианты.",
    how: "/bet Вопрос | Вариант1 | Вариант2",
    launchable: false,
  },
  taboo: {
    desc: "Объясни слово, не называя табу-слова.",
    launchable: true,
  },
};

function gameItem(key: FeatureKey): FeatureMenuItem {
  const info = FEATURE_INFO[key];
  const extra = GAME_EXTRA[key];
  return {
    id: key,
    label: info.label,
    featureKey: key,
    desc: extra?.desc ?? info.label.replace(/^[^\s]+\s/, ""),
    how: extra?.how ?? info.how,
    launchable: extra?.launchable ?? true,
  };
}

/** Items per category. */
export const MENU_BY_CATEGORY: Record<FeatureCategory, FeatureMenuItem[]> = {
  games: [
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
  ].map((k) => gameItem(k as FeatureKey)),
  economy: ECONOMY_ITEMS,
  social: [gameItem("tumba"), gameItem("ama"), gameItem("shipping"), gameItem("checkin")],
  autopilot: [
    gameItem("random_triggers"),
    gameItem("word_reactions"),
    gameItem("prediction"),
    gameItem("excuse"),
  ],
};

const MENU_LABEL: Partial<Record<FeatureMenuId, string>> = {
  tumba: "🍬 Тумба",
  ama: "❓ AMA",
  shipping: "💘 Прогрессивный шиппинг",
  random_triggers: "🎲 Слежка за чатом",
  word_reactions: "🔥 Реакции на триггеры",
};

for (const items of Object.values(MENU_BY_CATEGORY)) {
  for (const item of items) {
    if (MENU_LABEL[item.id]) item.label = MENU_LABEL[item.id]!;
  }
}

const AUTOPILOT_DESC: Partial<Record<FeatureKey, string>> = {
  random_triggers:
    "Сам пишет при тишине 2–4ч и редко влезает в живой разговор без @mention.",
  word_reactions: "Ставит эмодзи на слова-триггеры (дедлайн, жиза, ору…).",
  prediction: "Случайное предсказание из банка Бешемека. Ответом на сообщение или /predictions @user — для другого мембера.",
  excuse: "Сгенерировать абсурдную отмазку.",
  checkin: "Дилеммы «А или Б» с тегами мемберов по очереди.",
};

for (const item of MENU_BY_CATEGORY.autopilot) {
  if (AUTOPILOT_DESC[item.featureKey]) item.desc = AUTOPILOT_DESC[item.featureKey]!;
  if (item.id === "random_triggers" || item.id === "word_reactions") item.launchable = false;
}

const SOCIAL_DESC: Partial<Record<FeatureKey, string>> = {
  tumba: "Анонимные сахарки — пиши в личке бота, в чате выходит дайджестом.",
  ama: "Анонимные вопросы для EB — через личку бота.",
  shipping: "Бот намекает на пары в чате. /ship_optin чтобы участвовать.",
  checkin: "Дилеммы «А или Б» — бот тегает мемберов по очереди, отвечай кнопкой или текстом.",
};

for (const item of MENU_BY_CATEGORY.social) {
  if (SOCIAL_DESC[item.featureKey]) item.desc = SOCIAL_DESC[item.featureKey]!;
  if (item.id === "tumba" || item.id === "ama" || item.id === "checkin") item.launchable = true;
  if (item.id === "shipping") item.launchable = true;
}

export function getMenuItem(category: FeatureCategory, itemId: string): FeatureMenuItem | null {
  return MENU_BY_CATEGORY[category]?.find((i) => i.id === itemId) ?? null;
}

export function findMenuItem(
  itemId: string,
): { category: FeatureCategory; item: FeatureMenuItem } | null {
  for (const category of Object.keys(MENU_BY_CATEGORY) as FeatureCategory[]) {
    const item = getMenuItem(category, itemId);
    if (item) return { category, item };
  }
  return null;
}


export function buildFeaturesRootKeyboard(map: Record<FeatureKey, boolean>) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [
    [{ text: "🎮 Игры", callback_data: "feat:games" }],
    [{ text: "🪙 Экономика", callback_data: "feat:economy" }],
    [{ text: "🍬 Социальное", callback_data: "feat:social" }],
  ];
  if (map.prediction) {
    rows.push([{ text: "🔮 Предсказания", callback_data: "feat:run:prediction" }]);
  }
  if (map.checkin) {
    rows.push([{ text: "🧠 Чекин А/Б", callback_data: "feat:run:checkin" }]);
  }
  return inlineKeyboard(rows);
}

export function featuresRootText(map: Record<FeatureKey, boolean>): string {
  return (
    "<b>Что я умею 🤙</b>\n\n" +
    "Выбери категорию — покажу фичи, команды и что включено (✅/🚫):\n\n" +
    FEATURE_MENU_CATEGORIES.map((id) => {
      const group = FEATURE_GROUPS.find((g) => g.id === id);
      const items = MENU_BY_CATEGORY[id];
      const on = items.filter((i) => map[i.featureKey]).length;
      return `${group?.title ?? id} — ${on}/${items.length} вкл.`;
    }).join("\n")
  );
}

export function featuresCategoryText(
  map: Record<FeatureKey, boolean>,
  category: FeatureCategory,
): string {
  const group = FEATURE_GROUPS.find((g) => g.id === category);
  const items = MENU_BY_CATEGORY[category];
  if (!group || !items) return "Категория не найдена.";
  const on = items.filter((i) => map[i.featureKey]).length;
  return (
    `<b>${group.title}</b>\n` +
    `${on}/${items.length} включено в этом чате.\n\n` +
    "Жми на фичу — описание и запуск 👇"
  );
}

export function buildFeaturesCategoryKeyboard(
  map: Record<FeatureKey, boolean>,
  category: FeatureCategory,
) {
  const items = MENU_BY_CATEGORY[category];
  const rows = items.map((item) => {
    const on = map[item.featureKey];
    return [{ text: formatMenuBtnLabel(item.label, on), callback_data: `feat:${category}:${item.id}` }];
  });
  rows.push([{ text: "⬅️ Назад", callback_data: "feat:back" }]);
  if (category !== "autopilot" && map.prediction) {
    rows.push([{ text: "🔮 Предсказания", callback_data: "feat:run:prediction" }]);
  }
  if (category === "social" && map.checkin) {
    rows.push([{ text: "🧠 Чекин А/Б", callback_data: "feat:run:checkin" }]);
  }
  return inlineKeyboard(rows);
}

export function featuresItemText(
  map: Record<FeatureKey, boolean>,
  category: FeatureCategory,
  item: FeatureMenuItem,
): string {
  const on = map[item.featureKey];
  const flag = on ? "✅ Включено" : "🚫 Выключено в этом чате";
  return [
    `<b>${item.label}</b>`,
    flag,
    "",
    item.desc,
    "",
    `▶️ Запуск: <code>${item.how}</code>`,
  ].join("\n");
}

export function buildFeaturesItemKeyboard(
  map: Record<FeatureKey, boolean>,
  category: FeatureCategory,
  item: FeatureMenuItem,
) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (item.launchable && map[item.featureKey]) {
    rows.push([{ text: "▶️ Запустить", callback_data: `feat:run:${item.id}` }]);
  }
  rows.push([{ text: "⬅️ Назад", callback_data: `feat:back:${category}` }]);
  return inlineKeyboard(rows);
}
