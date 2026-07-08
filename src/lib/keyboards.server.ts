import { inlineKeyboard, type InlineButton } from "@/lib/telegram.server";
import type { FeatureKey } from "@/lib/features.server";
import {
  TG_INLINE_BTN_MAX,
  truncateBtn,
  stripLeadingEmoji,
  formatMenuBtnLabel,
  buildShopBuyKeyboard,
} from "@/lib/btn-label.server";

export {
  TG_INLINE_BTN_MAX,
  truncateBtn,
  stripLeadingEmoji,
  formatMenuBtnLabel,
  buildShopBuyKeyboard,
} from "@/lib/btn-label.server";

export {
  buildFeaturesRootKeyboard,
  featuresRootText,
  featuresCategoryText,
  buildFeaturesCategoryKeyboard,
  featuresItemText,
  buildFeaturesItemKeyboard,
  getMenuItem,
  findMenuItem,
  MENU_BY_CATEGORY,
  type FeatureCategory,
  type FeatureMenuId,
} from "@/lib/features-menu.server";

/** Reply-keyboard labels (DM only). Pressing sends this exact text. */
export const DM_MENU = {
  balance: "🪙 Баланс",
  shop: "🛍 Шоп",
  top: "🏆 Топ",
  gift: "🎁 Подарить",
  commands: "📋 Все команды",
  prediction: "🔮 Предсказание",
  excuse: "🙃 Отмазка",
  tumba: "🍬 Тумба",
  settings: "⚙️ Настройки",
} as const;

export const DM_MENU_TEXTS = new Set<string>(Object.values(DM_MENU));

export function buildDmReplyKeyboard() {
  return {
    keyboard: [
      [DM_MENU.balance, DM_MENU.shop],
      [DM_MENU.top, DM_MENU.gift],
      [DM_MENU.commands, DM_MENU.prediction],
      [DM_MENU.tumba, DM_MENU.excuse, DM_MENU.settings],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

export function removeReplyKeyboard() {
  return { remove_keyboard: true };
}

export function optionLetterButtons(
  options: string[],
  callback: (i: number) => string,
): InlineButton[][] {
  const letters = ["А", "Б", "В", "Г", "Д", "Е"];
  return options.slice(0, 6).map((opt, i) => [
    {
      text: truncateBtn(`${letters[i] ?? i + 1}. ${opt}`, TG_INLINE_BTN_MAX),
      callback_data: callback(i),
    },
  ]);
}
