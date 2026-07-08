// Starter word/prompt banks (spec 3.2/3.4). Not admin-editable yet — seed only.

export const CROCODILE_WORDS = {
  usual: [
    "жираф",
    "светофор",
    "бумеранг",
    "пицца",
    "вулкан",
    "холодильник",
    "парашют",
    "будильник",
    "аквариум",
    "эскалатор",
  ],
  aiesec: [
    "Roll Call",
    "Induction",
    "Handover",
    "Buddy",
    "Apply",
    "Deadline по KPI",
    "Национальная конференция",
    "LCM",
  ],
  brainrot: ["скибиди туалет", "сигма грайндсет", "рюкзак Хабиби", "брейнрот", "гигачад"],
};

export const TABOO_CARDS = [
  { word: "Roll Call", forbidden: ["традиция", "кричалка", "конфа", "делегация"] },
  { word: "LCM", forbidden: ["собрание", "лк", "встреча", "созвон"] },
  { word: "Дедлайн", forbidden: ["срок", "время", "успеть", "горит"] },
  { word: "Handover", forbidden: ["передача", "новый состав", "дела", "эстафета"] },
  { word: "Buddy", forbidden: ["куратор", "иностранец", "обмен", "друг"] },
  { word: "Induction", forbidden: ["вводный", "новички", "знакомство", "старт"] },
  { word: "Apply", forbidden: ["заявка", "отбор", "кандидат", "подать"] },
  { word: "KPI", forbidden: ["показатель", "план", "цифры", "выполнение"] },
  { word: "EP", forbidden: ["проект", "стажировка", "зарубеж", "программа"] },
  { word: "ICX", forbidden: ["иностранец", "волонтёр", "приём", "культура"] },
  { word: "OGX", forbidden: ["отправка", "стажировка", "за границу", "программа"] },
  { word: "TM", forbidden: ["тренинг", "обучение", "фасилитатор", "воркшоп"] },
  { word: "LCVP", forbidden: ["вице", "президент", "EB", "должность"] },
  { word: "Конференция", forbidden: ["съезд", "делегаты", "отель", "выступление"] },
  { word: "Джейдишка", forbidden: ["футболка", "мерч", "одежда", "символ"] },
];

export function pickMineSuggestions(secretWord: string, count = 4): string[] {
  const card = TABOO_CARDS.find((c) => c.word === secretWord);
  const generic = ["созвон", "дедлайн", "конфа", "проект", "команда", "отчёт", "план", "встреча"];
  const pool = [...(card?.forbidden ?? []), ...generic.filter((w) => w !== secretWord.toLowerCase())];
  const unique = [...new Set(pool.map((w) => w.trim()).filter(Boolean))];
  const shuffled = [...unique].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export function pickTabooWord(used: string[]): string {
  const pool = TABOO_CARDS.map((c) => c.word).filter((w) => !used.includes(w));
  const words = pool.length ? pool : TABOO_CARDS.map((c) => c.word);
  return words[Math.floor(Math.random() * words.length)];
}

export const TRUTH_OR_DARE = {
  truth: {
    light: [
      "Какая твоя любимая функция в AIESEC и почему?",
      "Кого из EB ты бы взял к себе в проект первым?",
      "Самый неловкий момент на конфе?",
    ],
    hard: [
      "Кому из чата ты бы никогда не доверил вести LCM?",
      "Честно: сколько раз ты пропускал созвон специально?",
      "Кто в локалке тебе реально нравится (по-дружески или нет)?",
    ],
  },
  dare: {
    light: [
      "Напиши LCP в личку, что уходишь в другую студенческую организацию, скинь скрин реакции.",
      "Поставь на аву эмодзи выбранное чатом на час.",
      "Напиши хвалебный пост про AIESEC в закреп чата.",
    ],
    hard: [
      "Запиши кружочек, где танцуешь ролл-колл без музыки.",
      "Позвони следующему в списке чата и спой ему AIESEC гимн (если есть) или любую песню 10 секунд.",
      "Смени имя в Telegram на «Официальный скуф локалки» на 2 часа.",
    ],
  },
};

export function randomCrocodileWord() {
  const categories = Object.keys(CROCODILE_WORDS) as (keyof typeof CROCODILE_WORDS)[];
  const category = categories[Math.floor(Math.random() * categories.length)];
  const words = CROCODILE_WORDS[category];
  return { word: words[Math.floor(Math.random() * words.length)], category };
}

export function containsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\W)${escaped}(\\W|$)`, "i");
  return re.test(text);
}
