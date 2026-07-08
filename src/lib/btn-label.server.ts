/** Telegram inline button text limit. */
export const TG_INLINE_BTN_MAX = 64;

/** Remove leading emoji and trailing parenthetical hints for compact labels. */
export function stripLeadingEmoji(text: string): string {
  return text
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\s]+/u, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
}

export function truncateBtn(text: string, max = TG_INLINE_BTN_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Features / menu item — one emoji + status, full label kept readable. */
export function formatMenuBtnLabel(label: string, on: boolean): string {
  const mark = on ? "✅" : "🚫";
  return truncateBtn(`${mark} ${label.trim()}`, TG_INLINE_BTN_MAX);
}

export function buildShopBuyKeyboard(items: { key: string; title: string; price: number }[]) {
  return {
    inline_keyboard: items.map((i) => [
      {
        text: truncateBtn(`🛒 ${i.title} — ${i.price}`, TG_INLINE_BTN_MAX),
        callback_data: `shop_buy:${i.key}`,
      },
    ]),
  };
}
