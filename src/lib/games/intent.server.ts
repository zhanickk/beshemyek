// Lightweight keyword-based intent detection so the bot can react to natural language like
// "го в мафию поиграем" or "бот закончи игру" instead of requiring exact slash commands.
// Deliberately NOT full NLU — cheap, deterministic, and only fires when the bot is
// mentioned/replied to (see webhook.ts), so it can't misfire during unrelated chatter.

export type NaturalGameKey =
  | "crocodile"
  | "taboo"
  | "truth_or_dare"
  | "mafia"
  | "cringe"
  | "who_said"
  | "aiesec_quiz"
  | "two_truths"
  | "meme_of_day"
  | "archetype_quiz"
  | "red_button"
  | "excuse_duel"
  | "quiz_duel";

const START_VERBS = /(го\b|давай|хочу|запусти|начни|начина|поигра|сыгра|катаем|запусти)/i;
const END_VERBS = /(заверш|законч|останов|прерв|хватит|стоп)/i;
const GAME_WORD = /игр/i;

const GAME_KEYWORDS: Array<{ key: NaturalGameKey; re: RegExp }> = [
  { key: "mafia", re: /мафи/i },
  { key: "crocodile", re: /крокодил/i },
  { key: "taboo", re: /табу/i },
  { key: "truth_or_dare", re: /правда или действ|прав(д)?у или действ/i },
  { key: "who_said", re: /кто это сказал|кто сказал/i },
  { key: "cringe", re: /кринж/i },
  { key: "excuse_duel", re: /дуэл.*отмаз|отмаз.*дуэл/i },
  { key: "quiz_duel", re: /дуэл/i },
  { key: "aiesec_quiz", re: /квиз|виктор/i },
  { key: "two_truths", re: /дв[ае] правд/i },
  { key: "meme_of_day", re: /мем дня/i },
  { key: "archetype_quiz", re: /архетип/i },
  { key: "red_button", re: /красн.{0,3}кнопк|ядерн.{0,3}чемодан|кнопк/i },
];

export type GameIntent = { kind: "start"; game: NaturalGameKey } | { kind: "end" } | null;

export function detectGameIntent(text: string): GameIntent {
  const t = text.toLowerCase();

  if (END_VERBS.test(t) && GAME_WORD.test(t)) {
    return { kind: "end" };
  }

  if (START_VERBS.test(t)) {
    for (const { key, re } of GAME_KEYWORDS) {
      if (re.test(t)) return { kind: "start", game: key };
    }
  }

  return null;
}
