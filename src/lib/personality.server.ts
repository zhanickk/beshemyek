// Personality flavor layered on top of the AI system prompt.
//
// Design goal (per explicit user feedback): humor must NOT flatten into one recurring bit or a
// small pool of stock phrases. So instead of returning fixed canned strings, most "flavor modes"
// return a *directive* that steers the model to generate a FRESH response of a certain shape
// (one word / surprise / confused). The only mode returned as literal text is the caps-mash,
// which is randomly generated in code (so it's different every time by construction).
//
// The special Kazakh/AIESEC slang words (Цунбятрм, Бинабат, Уопшым, Срошна, Кабуто) are the one
// place a small fixed vocabulary is acceptable — but they must be used rarely, never every message.

export const KAZAKH_SLANG_NOTE = `Есть набор словечек-приправ, которые можно ИЗРЕДКА и к месту вставлять (не в каждом сообщении, а рандомно и нечасто, чтобы не приедалось):
- «цунбятрм» — «не понимаю / не догоняю»; когда кто-то написал что-то мутное.
- «цунбятрм, галасабуй жазып жберш» — когда просишь объяснить попроще.
- «бинабат» — словечко-связка.
- «уопшым» — замена «короче».
- «срошна» — «срочно».
- «кабуто» — «как будто».
Это ограниченный набор — используй в меру и вперемешку с обычной речью, а не как основной стиль.`;

const VARIETY_NOTE = `Держи максимальное разнообразие: рифмы, брейнрот, мемы, шутки и реакции должны быть КАЖДЫЙ РАЗ новыми и своими. Не повторяй прошлые формулировки и не крути по кругу один и тот же набор фраз. Айсековские термины — только по делу и в меру, не в каждом сообщении.`;

export type ResponseMode = "normal" | "one_word" | "surprised" | "brainrot_capsmash" | "confused";

function weightedPick<T extends string>(weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [key, w] of entries) {
    roll -= w;
    if (roll <= 0) return key;
  }
  return entries[0][0];
}

export function pickResponseMode(): ResponseMode {
  // Flavor modes are intentionally the minority so normal, varied replies dominate.
  return weightedPick<ResponseMode>({
    normal: 74,
    one_word: 9,
    surprised: 7,
    brainrot_capsmash: 3,
    confused: 7,
  });
}

function randomCapsMash(): string {
  const letters = "АВЛОГИВШМЫРОЕСДЖУКНПТ";
  const len = 16 + Math.floor(Math.random() * 40);
  let out = "";
  for (let i = 0; i < len; i++) out += letters[Math.floor(Math.random() * letters.length)];
  return out;
}

/**
 * Resolves a response mode into either literal `text` (send as-is, skip the AI call) or a
 * `directive` to append to the system prompt so the model generates a fresh reply of that shape.
 */
export function resolveResponseMode(mode: ResponseMode): {
  text: string | null;
  directive: string;
} {
  const base = `${VARIETY_NOTE}\n\n${KAZAKH_SLANG_NOTE}`;

  switch (mode) {
    case "brainrot_capsmash": {
      // Fully code-generated, so it's unique every time — simulates being fed up / short-circuiting.
      const mash = randomCapsMash();
      const tail =
        Math.random() < 0.6
          ? ` ${["...", ".. всё, отвис", ".. сорян, залип", ".. окей я обратно"][Math.floor(Math.random() * 4)]}`
          : "";
      return { text: `${mash}${tail}`, directive: base };
    }
    case "one_word":
      return {
        text: null,
        directive: `${base}\n\nСЕЙЧАС ответь МАКСИМАЛЬНО коротко — одним словом или очень коротким междометием-реакцией. Придумай свежее и небанальное, не повторяй заезженное.`,
      };
    case "surprised":
      return {
        text: null,
        directive: `${base}\n\nСЕЙЧАС вырази удивление очень коротко (1–3 слова), придумай СВЕЖУЮ реакцию, не используй заезженные шаблоны.`,
      };
    case "confused":
      return {
        text: null,
        directive: `${base}\n\nСЕЙЧАС сделай вид, что не догнал/не понял замудрёное сообщение — коротко и с юмором. Можешь (не обязательно) вставить одно словечко из набора-приправы. Сформулируй по-новому, не копируй примеры дословно.`,
      };
    case "normal":
    default:
      return { text: null, directive: base };
  }
}
