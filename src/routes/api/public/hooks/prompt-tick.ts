import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { telegram, T, type Lang } from "@/lib/telegram.server";

function getAdmin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export const Route = createFileRoute("/api/public/hooks/prompt-tick")({
  server: {
    handlers: {
      POST: async () => {
        const supabase = getAdmin();
        const nowHour = new Date().getUTCHours();
        const { data: chats } = await supabase
          .from("chats")
          .select("id, telegram_chat_id, bot_settings(prompt_frequency, prompt_hour_utc, prompts_enabled, quiet_start, quiet_end)")
          .eq("is_active", true);

        const { data: prompts } = await supabase.from("prompts").select("text").eq("is_active", true);
        if (!prompts || prompts.length === 0) return Response.json({ ok: true, sent: 0 });

        let sent = 0;
        for (const chat of chats ?? []) {
          const s: any = Array.isArray(chat.bot_settings) ? chat.bot_settings[0] : chat.bot_settings;
          if (!s || !s.prompts_enabled) continue;

          // Quiet hours
          if (s.quiet_start != null && s.quiet_end != null) {
            const inQuiet =
              s.quiet_start < s.quiet_end
                ? nowHour >= s.quiet_start && nowHour < s.quiet_end
                : nowHour >= s.quiet_start || nowHour < s.quiet_end;
            if (inQuiet) continue;
          }

          let shouldFire = false;
          if (s.prompt_frequency === "hourly") shouldFire = true;
          else if (s.prompt_frequency === "daily") shouldFire = nowHour === (s.prompt_hour_utc ?? 14);
          else if (s.prompt_frequency === "twice_daily")
            shouldFire = nowHour === (s.prompt_hour_utc ?? 14) || nowHour === ((s.prompt_hour_utc ?? 14) + 12) % 24;
          if (!shouldFire) continue;

          const text = prompts[Math.floor(Math.random() * prompts.length)].text;
          try {
            await telegram.sendMessage(chat.telegram_chat_id, `💬 <b>Conversation starter:</b>\n${text}`);
            await supabase.from("bot_sends").insert({
              telegram_chat_id: chat.telegram_chat_id,
              kind: "prompt",
              content: text,
            });
            sent++;
          } catch (e) {
            console.error("prompt send failed", chat.telegram_chat_id, e);
          }
        }
        return Response.json({ ok: true, sent });
      },
    },
  },
});
