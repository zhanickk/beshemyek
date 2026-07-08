import { createFileRoute } from "@tanstack/react-router";
import { getAdmin } from "@/lib/supabase-admin.server";
import { runPromptTick } from "@/lib/prompt-tick.server";
import { verifyTickSecret } from "@/lib/cron.server";

export const Route = createFileRoute("/api/public/hooks/prompt-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!verifyTickSecret(request.headers.get("X-Cron-Secret"))) {
          return new Response("Unauthorized", { status: 401 });
        }
        const result = await runPromptTick(getAdmin());
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
