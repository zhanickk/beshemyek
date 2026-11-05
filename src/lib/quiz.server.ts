import type { SupabaseClient } from "@supabase/supabase-js";
import { awardCoins } from "@/lib/economy.server";

export async function handlePollAnswer(
  admin: SupabaseClient,
  pollAnswer: { poll_id: string; user?: { id: number }; option_ids: number[] },
) {
  if (!pollAnswer.user) return;
  const { data: poll } = await admin
    .from("polls")
    .select("*")
    .eq("telegram_poll_id", pollAnswer.poll_id)
    .maybeSingle();
  if (!poll || poll.correct_option == null) return;
  if (!["trivia", "aiesec_quiz"].includes(poll.kind)) return;

  const { data: chat } = await admin
    .from("chats")
    .select("id")
    .eq("telegram_chat_id", poll.telegram_chat_id)
    .maybeSingle();
  if (!chat) return;

  const correct = pollAnswer.option_ids.includes(poll.correct_option);
  if (correct) {
    await awardCoins(admin, chat.id, pollAnswer.user.id, 15, "game_win", { game: poll.kind });
  }
}
