/**
 * Detects messages that are pure laughter/keyboard-mash noise
 * (e.g. "ахахаха", "хахахах", "ахвхавхахав") with no real content,
 * so the bot can skip generating an AI reply to them.
 */
export function isPureLaughSpam(text: string): boolean {
  const cleaned = text.toLowerCase().replace(/[^а-яa-z]/gi, "");
  if (cleaned.length < 4) return false;
  if (!/^[ахвxa]+$/i.test(cleaned)) return false;
  return /ха|ах/.test(cleaned);
}
