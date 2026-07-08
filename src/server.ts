import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;
let botCommandsSynced = false;

async function ensureBotCommands() {
  if (botCommandsSynced) return;
  botCommandsSynced = true;
  try {
    const { syncBotCommands } = await import("./lib/telegram.server");
    await syncBotCommands();
  } catch (e) {
    botCommandsSynced = false;
    console.error("ensureBotCommands failed", e);
  }
}

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function runScheduled(event: { cron?: string }) {
  const { getAdmin } = await import("./lib/supabase-admin.server");
  const { runFastTicks, runTumbaDigestTick } = await import("./lib/cron.server");
  const { runPromptTick } = await import("./lib/prompt-tick.server");
  const admin = getAdmin();

  if (event.cron === "0 18 * * *") {
    await runTumbaDigestTick(admin);
    return;
  }
  // Default: the once-a-minute trigger drives prompt/engagement/game/shipping ticks.
  await Promise.all([
    runPromptTick(admin).catch((e) => console.error("prompt tick failed", e)),
    runFastTicks(admin).catch((e) => console.error("fast ticks failed", e)),
  ]);
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const ctxWithWait = ctx as { waitUntil?: (p: Promise<unknown>) => void };
    ctxWithWait.waitUntil?.(ensureBotCommands());
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
  async scheduled(
    event: { cron?: string },
    _env: unknown,
    ctx: { waitUntil: (p: Promise<unknown>) => void },
  ) {
    ctx.waitUntil(runScheduled(event).catch((error) => console.error("scheduled() failed", error)));
  },
};
