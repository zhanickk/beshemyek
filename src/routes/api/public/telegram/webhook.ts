import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { generateText } from "ai";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { telegram, verifyTelegramSecret, resolveLang, detectLanguage, T, type Lang } from "@/lib/telegram.server";

function getAdmin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function generateAiReply(userMessage: string, tone: string, lang: Lang): Promise<string> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return T.aiFallback[lang];
  const gateway = createLovableAiGatewayProvider(key);
  const system = `${T.aiSystem[lang]}\nTone: ${tone}`;
  try {
    const { text } = await generateText({
      model: gateway("google/gemini-3-flash-preview"),
      system,
      prompt: userMessage,
    });
    return text?.trim() || T.aiFallback[lang];
  } catch (e) {
    console.error("AI reply failed", e);
    return T.aiFallback[lang];
  }
}

type TgUser = { id: number; username?: string; first_name?: string; is_bot?: boolean; language_code?: string };
type TgChat = { id: number; type: string; title?: string; username?: string };
type TgEntity = { type: string; offset: number; length: number };
type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  entities?: TgEntity[];
  reply_to_message?: { from?: TgUser };
};

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!verifyTelegramSecret(request.headers.get("X-Telegram-Bot-Api-Secret-Token"))) {
          return new Response("Unauthorized", { status: 401 });
        }
        const update = await request.json();
        const message: TgMessage | undefined = update.message ?? update.edited_message;
        const supabase = getAdmin();

        if (typeof update.update_id === "number") {
          await supabase.from("messages_log").upsert(
            {
              update_id: update.update_id,
              telegram_chat_id: message?.chat?.id ?? 0,
              from_user_id: message?.from?.id ?? null,
              from_username: message?.from?.username ?? null,
              text: message?.text ?? null,
              kind: message?.text?.startsWith("/") ? "command" : "message",
              raw: update,
            },
            { onConflict: "update_id" },
          );
        }

        if (update.my_chat_member) {
          const chat = update.my_chat_member.chat;
          const status = update.my_chat_member.new_chat_member?.status;
          const active = status === "member" || status === "administrator";
          const { data: existing } = await supabase
            .from("chats")
            .select("id")
            .eq("telegram_chat_id", chat.id)
            .maybeSingle();
          if (existing) {
            await supabase.from("chats").update({ is_active: active, title: chat.title }).eq("id", existing.id);
          } else if (active) {
            const { data: inserted } = await supabase
              .from("chats")
              .insert({ telegram_chat_id: chat.id, title: chat.title, chat_type: chat.type, is_active: true })
              .select("id")
              .single();
            if (inserted) {
              await supabase.from("bot_settings").insert({ chat_id: inserted.id });
              const lang = detectLanguage(null, update.my_chat_member.from?.language_code);
              try {
                await telegram.sendMessage(chat.id, T.welcome[lang]);
                await supabase.from("bot_sends").insert({
                  telegram_chat_id: chat.id,
                  kind: "welcome",
                  content: "Welcome message",
                });
              } catch (e) {
                console.error(e);
              }
            }
          }
          return Response.json({ ok: true });
        }

        if (!message || !message.chat?.id) return Response.json({ ok: true });

        const chatId = message.chat.id;
        const text = message.text ?? "";

        let { data: chatRow } = await supabase
          .from("chats")
          .select("id")
          .eq("telegram_chat_id", chatId)
          .maybeSingle();
        if (!chatRow) {
          const { data: ins } = await supabase
            .from("chats")
            .insert({
              telegram_chat_id: chatId,
              title: message.chat.title ?? message.chat.username ?? "Private chat",
              chat_type: message.chat.type,
              is_active: true,
            })
            .select("id")
            .single();
          if (ins) {
            chatRow = ins;
            await supabase.from("bot_settings").insert({ chat_id: ins.id });
          }
        }

        const { data: settings } = chatRow
          ? await supabase.from("bot_settings").select("*").eq("chat_id", chatRow.id).maybeSingle()
          : { data: null };

        const lang: Lang = resolveLang(settings?.language, text, message.from?.language_code);

        let botUsername: string | undefined;
        try {
          const me: any = await telegram.getMe();
          botUsername = me?.result?.username;
        } catch {}

        if (text.startsWith("/")) {
          const cmd = text.split(/\s|@/)[0].toLowerCase();
          if (cmd === "/start" || cmd === "/help") {
            await telegram.sendMessage(chatId, T.help[lang]);
            return Response.json({ ok: true });
          }
          if (cmd === "/icebreaker") {
            let q = supabase.from("prompts").select("text,language").eq("is_active", true);
            const { data: allPrompts } = await q;
            const filtered = (allPrompts ?? []).filter((p: any) => p.language === lang);
            const pool = filtered.length > 0 ? filtered : (allPrompts ?? []);
            const prompt = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)].text : null;
            if (prompt) {
              await telegram.sendMessage(chatId, `${T.icebreakerLabel[lang]}\n${prompt}`);
              await supabase.from("bot_sends").insert({
                telegram_chat_id: chatId,
                kind: "prompt",
                content: prompt,
              });
            }
            return Response.json({ ok: true });
          }
          if (cmd === "/poll") {
            const rest = text.slice(cmd.length).trim();
            const parts = rest.split("|").map((s) => s.trim()).filter(Boolean);
            if (parts.length < 3) {
              await telegram.sendMessage(chatId, T.pollUsage[lang]);
              return Response.json({ ok: true });
            }
            const [question, ...options] = parts;
            try {
              const res: any = await telegram.sendPoll(chatId, question, options.slice(0, 10));
              await supabase.from("polls").insert({
                telegram_chat_id: chatId,
                telegram_poll_id: res?.result?.poll?.id ?? null,
                telegram_message_id: res?.result?.message_id ?? null,
                question,
                options: options.slice(0, 10),
                kind: "poll",
              });
              await supabase.from("bot_sends").insert({
                telegram_chat_id: chatId,
                kind: "poll",
                content: question,
              });
            } catch (e: any) {
              await telegram.sendMessage(chatId, `${T.pollFailed[lang]}${e.message}`);
            }
            return Response.json({ ok: true });
          }
          if (cmd === "/trivia") {
            if (!(settings?.polls_enabled ?? true)) return Response.json({ ok: true });
            try {
              const key = process.env.LOVABLE_API_KEY!;
              const gateway = createLovableAiGatewayProvider(key);
              const { text: raw } = await generateText({
                model: gateway("google/gemini-3-flash-preview"),
                system: T.triviaPrompt[lang],
                prompt: lang === "ru" ? "Сгенерируй один вопрос викторины." : "Generate one trivia question.",
              });
              const cleaned = raw.replace(/```json|```/g, "").trim();
              const parsed = JSON.parse(cleaned);
              const res: any = await telegram.sendPoll(chatId, `🎯 ${parsed.question}`, parsed.options, {
                type: "quiz",
                correct_option_id: parsed.correct,
                is_anonymous: false,
              });
              await supabase.from("polls").insert({
                telegram_chat_id: chatId,
                telegram_poll_id: res?.result?.poll?.id ?? null,
                telegram_message_id: res?.result?.message_id ?? null,
                question: parsed.question,
                options: parsed.options,
                correct_option: parsed.correct,
                kind: "trivia",
              });
              await supabase.from("bot_sends").insert({
                telegram_chat_id: chatId,
                kind: "trivia",
                content: parsed.question,
              });
            } catch (e: any) {
              console.error(e);
              await telegram.sendMessage(chatId, T.triviaFailed[lang]);
            }
            return Response.json({ ok: true });
          }
          return Response.json({ ok: true });
        }

        const mentionsBot =
          (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) ||
          message.reply_to_message?.from?.is_bot;
        if (mentionsBot && (settings?.ai_replies_enabled ?? true) && text.trim()) {
          const tone = settings?.tone ?? "Chill bro vibe, playful banter, never preachy.";
          const cleanText = botUsername ? text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim() : text;
          const reply = await generateAiReply(cleanText, tone, lang);
          await telegram.sendMessage(chatId, reply, { reply_to_message_id: message.message_id });
          await supabase.from("bot_sends").insert({
            telegram_chat_id: chatId,
            kind: "ai_reply",
            content: reply,
          });
        }

        return Response.json({ ok: true });
      },
    },
  },
});
