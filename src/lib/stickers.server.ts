import type { SupabaseClient } from "@supabase/supabase-js";

export type StickerCategory = "радость" | "кринж" | "обида" | "угар" | "победа";

/** Returns a random sticker file_id for the category, or null if none uploaded yet (spec 8.3: category tags picked by LLM/code, not a specific file). */
export async function pickSticker(
  admin: SupabaseClient,
  category: StickerCategory,
): Promise<string | null> {
  const { data } = await admin.from("stickers").select("file_id").eq("category", category);
  if (!data || data.length === 0) return null;
  return data[Math.floor(Math.random() * data.length)].file_id;
}
