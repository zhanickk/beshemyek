import { definePlugin } from "nitro";

async function runScheduledCron(cron: string | undefined) {
  const { getAdmin } = await import("../src/lib/supabase-admin.server");
  const { runFastTicks, runTumbaDigestTick } = await import("../src/lib/cron.server");
  const { runPromptTick } = await import("../src/lib/prompt-tick.server");
  const admin = getAdmin();

  if (cron === "0 18 * * *") {
    await runTumbaDigestTick(admin);
    return;
  }

  await Promise.all([
    runPromptTick(admin).catch((e) => console.error("prompt tick failed", e)),
    runFastTicks(admin).catch((e) => console.error("fast ticks failed", e)),
  ]);
}

/** Cloudflare cron triggers call nitro's scheduled handler — wire bot ticks here. */
export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("cloudflare:scheduled", async ({ controller, context }) => {
    const work = runScheduledCron(controller?.cron).catch((e) =>
      console.error("cloudflare:scheduled tick failed", e),
    );
    context?.waitUntil?.(work);
    await work;
  });
});
