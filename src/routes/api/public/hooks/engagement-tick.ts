import { createFileRoute } from "@tanstack/react-router";
import { getAdmin } from "@/lib/supabase-admin.server";
import { runEngagementTick } from "@/lib/engagement.server";
import { verifyTickSecret } from "@/lib/cron.server";

export const Route = createFileRoute("/api/public/hooks/engagement-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!verifyTickSecret(request.headers.get("X-Cron-Secret"))) {
          return new Response("Unauthorized", { status: 401 });
        }
        await runEngagementTick(getAdmin());
        return Response.json({ ok: true });
      },
    },
  },
});
