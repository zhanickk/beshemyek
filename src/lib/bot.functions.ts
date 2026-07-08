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
        language: z.enum(["en", "ru"]).default("en"),
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
        language: z.enum(["auto", "en", "ru"]).optional(),
        is_paused: z.boolean().optional(),
        silence_threshold_min: z.number().min(5).max(1440).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { chat_id, ...patch } = data;
    const { error } = await context.supabase
      .from("bot_settings")
      .update(patch)
      .eq("chat_id", chat_id);
    if (error) throw error;
    return { ok: true };
  });

export const sendPromptNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ telegram_chat_id: z.number() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { telegram } = await import("@/lib/telegram.server");
    const { data: prompts } = await context.supabase
      .from("prompts")
      .select("text")
      .eq("is_active", true);
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
      context.supabase
        .from("messages_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
      context.supabase
        .from("bot_sends")
        .select("*")
        .order("sent_at", { ascending: false })
        .limit(50),
    ]);
    return { messages: msgs.data ?? [], sends: sends.data ?? [] };
  });

export const listMemberActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ chat_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const [mostActive, quietest] = await Promise.all([
      context.supabase
        .from("chat_members")
        .select("telegram_user_id, username, display_name, message_count, last_active_at")
        .eq("chat_id", data.chat_id)
        .order("message_count", { ascending: false })
        .limit(10),
      context.supabase
        .from("chat_members")
        .select("telegram_user_id, username, display_name, message_count, last_active_at")
        .eq("chat_id", data.chat_id)
        .order("last_active_at", { ascending: true })
        .limit(10),
    ]);
    return {
      mostActive: mostActive.data ?? [],
      quietest: quietest.data ?? [],
    };
  });

export const getStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as any);
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const [chats, msgsToday, promptsToday, ai] = await Promise.all([
      context.supabase
        .from("chats")
        .select("id", { count: "exact", head: true })
        .eq("is_active", true),
      context.supabase
        .from("messages_log")
        .select("update_id", { count: "exact", head: true })
        .gte("created_at", since),
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

const FEATURE_KEYS = [
  "mafia",
  "crocodile",
  "truth_or_dare",
  "taboo",
  "cringe",
  "aiesec_quiz",
  "excuse",
  "two_truths",
  "meme_of_day",
  "totalizator",
  "who_said_this",
  "archetype_quiz",
  "ama",
  "tumba",
  "shipping",
  "random_triggers",
  "economy",
  "red_button",
  "excuse_duel",
  "quiz_duel",
  "prediction",
  "word_reactions",
  "checkin",
] as const;

export const listChatFeatures = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ chat_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { data: rows, error } = await context.supabase
      .from("chat_features")
      .select("*")
      .eq("chat_id", data.chat_id);
    if (error) throw error;
    const overrides = new Map(rows?.map((r) => [r.feature_key, r.enabled]) ?? []);
    return FEATURE_KEYS.map((key) => ({
      key,
      enabled: overrides.has(key) ? !!overrides.get(key) : true,
    }));
  });

export const setChatFeature = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ chat_id: z.string().uuid(), feature_key: z.string(), enabled: z.boolean() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { error } = await context.supabase
      .from("chat_features")
      .upsert(
        { chat_id: data.chat_id, feature_key: data.feature_key, enabled: data.enabled },
        { onConflict: "chat_id,feature_key" },
      );
    if (error) throw error;
    return { ok: true };
  });

export const setBotPaused = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ chat_id: z.string().uuid(), is_paused: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { error } = await context.supabase
      .from("bot_settings")
      .update({ is_paused: data.is_paused })
      .eq("chat_id", data.chat_id);
    if (error) throw error;
    return { ok: true };
  });

export const listLeaderboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ chat_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { data: rows, error } = await context.supabase
      .from("chat_members")
      .select("*")
      .eq("chat_id", data.chat_id)
      .order("coins", { ascending: false })
      .limit(50);
    if (error) throw error;
    return rows ?? [];
  });

export const adjustMemberCoins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ chat_id: z.string().uuid(), telegram_user_id: z.number(), delta: z.number() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { awardCoins } = await import("@/lib/economy.server");
    await awardCoins(
      context.supabase as any,
      data.chat_id,
      data.telegram_user_id,
      data.delta,
      "admin_adjust",
    );
    return { ok: true };
  });

export const listShopItems = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as any);
    const { data, error } = await context.supabase
      .from("shop_items")
      .select("*")
      .order("price", { ascending: true });
    if (error) throw error;
    return data ?? [];
  });

export const upsertShopItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid().optional(),
        key: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        price: z.number().min(0),
        is_active: z.boolean().default(true),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    if (data.id) {
      const { error } = await context.supabase.from("shop_items").update(data).eq("id", data.id);
      if (error) throw error;
    } else {
      const { error } = await context.supabase.from("shop_items").insert(data);
      if (error) throw error;
    }
    return { ok: true };
  });

export const listTumbaQueue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as any);
    const { data, error } = await context.supabase
      .from("tumba_messages")
      .select("*, chats(title)")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return data ?? [];
  });

export const moderateTumbaMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), status: z.enum(["approved", "blocked"]) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { error } = await context.supabase
      .from("tumba_messages")
      .update({ status: data.status })
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const listStickers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as any);
    const { data, error } = await context.supabase.from("stickers").select("*").order("category");
    if (error) throw error;
    return data ?? [];
  });

export const importStickerFromUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        telegram_chat_id: z.number(),
        image_url: z.string().url(),
        category: z.string().min(1),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { telegram } = await import("@/lib/telegram.server");
    // Telegram fetches the URL server-side and hands back a reusable file_id — no local file upload needed.
    const res: any = await telegram.sendDocument(data.telegram_chat_id, data.image_url, {
      caption: `Sticker import: ${data.category}`,
    });
    const fileId = res?.result?.document?.file_id;
    if (!fileId) throw new Error("Telegram didn't return a file_id for this image.");
    const { error } = await context.supabase
      .from("stickers")
      .insert({ category: data.category, file_id: fileId });
    if (error) throw error;
    return { ok: true, file_id: fileId };
  });

export const addStickerFileId = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        category: z.string().min(1),
        file_id: z.string().min(1),
        sticker_set_name: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { error } = await context.supabase.from("stickers").insert(data);
    if (error) throw error;
    return { ok: true };
  });

export const deleteSticker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context as any);
    const { error } = await context.supabase.from("stickers").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });
