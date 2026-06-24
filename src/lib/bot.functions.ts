import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function requireAdmin(ctx: { supabase: any; userId: string }) {
  const { data } = await ctx.supabase.rpc("has_role", { _user_id: ctx.userId, _role: "admin" });
  if (!data) throw new Error("Forbidden: admin required");
}

export const listChats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as any);
    const { data, error } = await context.supabase
      .from("chats")
      .select("*, bot_settings(*)")
      .order("joined_at", { ascending: false });
    if (error) throw error;
    return data;
  });

export const listPrompts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as any);
    const { data, error } = await context.supabase
      .from("prompts")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  });

export const upsertPrompt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid().optional(),
        text: z.string().min(3),
        category: z.string().default("icebreaker"),
        is_active: z.boolean().default(true),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    if (data.id) {
      const { error } = await context.supabase.from("prompts").update(data).eq("id", data.id);
      if (error) throw error;
    } else {
      const { error } = await context.supabase.from("prompts").insert(data);
      if (error) throw error;
    }
    return { ok: true };
  });

export const deletePrompt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { error } = await context.supabase.from("prompts").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const updateChatSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        chat_id: z.string().uuid(),
        ai_replies_enabled: z.boolean().optional(),
        prompts_enabled: z.boolean().optional(),
        polls_enabled: z.boolean().optional(),
        prompt_frequency: z.enum(["off", "daily", "twice_daily", "hourly"]).optional(),
        prompt_hour_utc: z.number().min(0).max(23).optional(),
        quiet_start: z.number().min(0).max(23).nullable().optional(),
        quiet_end: z.number().min(0).max(23).nullable().optional(),
        tone: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { chat_id, ...patch } = data;
    const { error } = await context.supabase.from("bot_settings").update(patch).eq("chat_id", chat_id);
    if (error) throw error;
    return { ok: true };
  });

export const sendPromptNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ telegram_chat_id: z.number() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { telegram } = await import("@/lib/telegram.server");
    const { data: prompts } = await context.supabase.from("prompts").select("text").eq("is_active", true);
    if (!prompts || prompts.length === 0) throw new Error("No active prompts");
    const text = prompts[Math.floor(Math.random() * prompts.length)].text;
    await telegram.sendMessage(data.telegram_chat_id, `💬 <b>Conversation starter:</b>\n${text}`);
    await context.supabase
      .from("bot_sends")
      .insert({ telegram_chat_id: data.telegram_chat_id, kind: "prompt", content: text });
    return { ok: true, text };
  });

export const listActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as any);
    const [msgs, sends] = await Promise.all([
      context.supabase.from("messages_log").select("*").order("created_at", { ascending: false }).limit(50),
      context.supabase.from("bot_sends").select("*").order("sent_at", { ascending: false }).limit(50),
    ]);
    return { messages: msgs.data ?? [], sends: sends.data ?? [] };
  });

export const getStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as any);
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const [chats, msgsToday, promptsToday, ai] = await Promise.all([
      context.supabase.from("chats").select("id", { count: "exact", head: true }).eq("is_active", true),
      context.supabase.from("messages_log").select("update_id", { count: "exact", head: true }).gte("created_at", since),
      context.supabase
        .from("bot_sends")
        .select("id", { count: "exact", head: true })
        .eq("kind", "prompt")
        .gte("sent_at", since),
      context.supabase
        .from("bot_sends")
        .select("id", { count: "exact", head: true })
        .eq("kind", "ai_reply")
        .gte("sent_at", since),
    ]);
    return {
      activeChats: chats.count ?? 0,
      messagesToday: msgsToday.count ?? 0,
      promptsToday: promptsToday.count ?? 0,
      aiRepliesToday: ai.count ?? 0,
    };
  });

export const getWebhookInfo = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as any);
    const { telegram } = await import("@/lib/telegram.server");
    const info: any = await telegram.getWebhookInfo();
    return info?.result ?? null;
  });

export const setBotWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ url: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { telegram } = await import("@/lib/telegram.server");
    const res = await telegram.setWebhook(data.url);
    return res;
  });

export const getBotInfo = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as any);
    const { telegram } = await import("@/lib/telegram.server");
    const me: any = await telegram.getMe();
    return me?.result ?? null;
  });
