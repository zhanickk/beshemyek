// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { config as loadDotenv } from "dotenv";

// `vite dev` runs a plain Node process — it doesn't read Cloudflare's `.dev.vars`
// the way `wrangler dev` does. Load it here so process.env.TELEGRAM_API_KEY,
// DEEPSEEK_API_KEY, SUPABASE_SERVICE_ROLE_KEY etc. are available to server code
// locally. In production the Worker runtime injects these directly (nodejs_compat),
// so this has no effect on the deployed build.
loadDotenv({ path: ".dev.vars" });

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  nitro: {
    preset: "cloudflare-module",
    cloudflare: {
      deployConfig: true,
      nodeCompat: true,
    },
    plugins: ["plugins/bot-cron.ts"],
  },
});
