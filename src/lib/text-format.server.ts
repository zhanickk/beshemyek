/**
 * Strips the classic "AI tic" long dash (em dash — / en dash –) from generated text and
 * replaces it with plain punctuation, so replies read like normal chat typing instead of
 * LLM-generated prose. Applied as a safety net after every AI generation call, since prompt
 * instructions alone don't reliably stop models from using it.
 */
export function stripLongDashes(text: string): string {
  if (!text) return text;
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/,\s*$/g, "")
    .replace(/^,\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
