import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listChats,
  updateChatSettings,
  sendPromptNow,
  listChatFeatures,
  setChatFeature,
} from "@/lib/bot.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Send } from "lucide-react";

const FEATURE_LABELS: Record<string, string> = {
  mafia: "🔪 Мафия",
  crocodile: "🐊 Крокодил",
  truth_or_dare: "🎯 Правда или действие",
  taboo: "🚫 Табу",
  cringe: "🫠 Кто этот Кринж",
  who_said_this: "🗣 Кто это сказал",
  aiesec_quiz: "🎓 AIESEC quiz",
  archetype_quiz: "🧪 Архетип-тест",
  excuse: "🙈 /excuse",
  two_truths: "🎭 Два правды и ложь",
  meme_of_day: "😂 Мем дня",
  totalizator: "🎰 Тотализатор",
  ama: "🎤 AMA с EB",
  tumba: "🍬 Тумба",
  shipping: "💘 Шиперинг",
  checkin: "🧠 Чекин А/Б",
  prediction: "🔮 Предсказания",
  random_triggers: "🎲 Случайные вбросы",
  economy: "🪙 Экономика",
};

function ChatFeatureToggles({ chatId }: { chatId: string }) {
  const list = useServerFn(listChatFeatures);
  const set = useServerFn(setChatFeature);
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["chat-features", chatId],
    queryFn: () => list({ data: { chat_id: chatId } }),
  });
  const mut = useMutation({
    mutationFn: (vars: { feature_key: string; enabled: boolean }) =>
      set({ data: { chat_id: chatId, ...vars } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chat-features", chatId] }),
    onError: (e: any) => toast.error(e.message),
  });

  if (!data) return null;
  return (
    <div className="space-y-2">
      <Label className="text-xs uppercase text-muted-foreground">Мини-игры и фичи</Label>
      <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-2">
        {data.map((f) => (
          <div
            key={f.key}
            className="flex items-center justify-between border rounded-md px-2 py-1.5 text-sm"
          >
            <span>{FEATURE_LABELS[f.key] ?? f.key}</span>
            <Switch
              checked={f.enabled}
              onCheckedChange={(v) => mut.mutate({ feature_key: f.key, enabled: v })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/_app/chats")({
  head: () => ({ meta: [{ title: "Chats · Chatkeeper" }] }),
  component: ChatsPage,
});

function ChatsPage() {
  const list = useServerFn(listChats);
  const update = useServerFn(updateChatSettings);
  const send = useServerFn(sendPromptNow);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["chats"], queryFn: () => list() });

  const updateMut = useMutation({
    mutationFn: (vars: any) => update({ data: vars }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["chats"] });
      toast.success("Saved");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const sendMut = useMutation({
    mutationFn: (chatId: number) => send({ data: { telegram_chat_id: chatId } }),
    onSuccess: () => toast.success("Prompt sent!"),
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Chats</h1>
        <p className="text-muted-foreground">Configure the bot's behavior per group.</p>
      </div>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && (!data || data.length === 0) && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            <p>No chats yet. Add the bot to a Telegram group to get started.</p>
          </CardContent>
        </Card>
      )}
      {data?.map((chat: any) => {
        const s = Array.isArray(chat.bot_settings) ? chat.bot_settings[0] : chat.bot_settings;
        if (!s) return null;
        return (
          <Card key={chat.id}>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle>{chat.title ?? "Untitled chat"}</CardTitle>
                  <CardDescription>
                    {chat.chat_type} · ID {chat.telegram_chat_id}
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sendMut.mutate(chat.telegram_chat_id)}
                >
                  <Send className="w-3 h-3 mr-2" /> Send prompt now
                </Button>
              </div>
            </CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-4">
              <div className="flex items-center justify-between">
                <Label>AI replies on @mention</Label>
                <Switch
                  checked={s.ai_replies_enabled}
                  onCheckedChange={(v) =>
                    updateMut.mutate({ chat_id: chat.id, ai_replies_enabled: v })
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>Scheduled prompts</Label>
                <Switch
                  checked={s.prompts_enabled}
                  onCheckedChange={(v) =>
                    updateMut.mutate({ chat_id: chat.id, prompts_enabled: v })
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>Polls & trivia</Label>
                <Switch
                  checked={s.polls_enabled}
                  onCheckedChange={(v) => updateMut.mutate({ chat_id: chat.id, polls_enabled: v })}
                />
              </div>
              <div className="space-y-1">
                <Label>Prompt frequency</Label>
                <Select
                  value={s.prompt_frequency}
                  onValueChange={(v) => updateMut.mutate({ chat_id: chat.id, prompt_frequency: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="twice_daily">Twice daily</SelectItem>
                    <SelectItem value="hourly">Hourly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Daily prompt hour (UTC)</Label>
                <Select
                  value={String(s.prompt_hour_utc)}
                  onValueChange={(v) =>
                    updateMut.mutate({ chat_id: chat.id, prompt_hour_utc: Number(v) })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 24 }).map((_, h) => (
                      <SelectItem key={h} value={String(h)}>
                        {h.toString().padStart(2, "0")}:00
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Bot language</Label>
                <Select
                  value={s.language ?? "auto"}
                  onValueChange={(v) => updateMut.mutate({ chat_id: chat.id, language: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto-detect</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="ru">Русский</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between">
                <Label>Пауза (тихий режим)</Label>
                <Switch
                  checked={s.is_paused ?? false}
                  onCheckedChange={(v) => updateMut.mutate({ chat_id: chat.id, is_paused: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Несколько игр одновременно</Label>
                  <p className="text-xs text-muted-foreground">
                    Разные мини-игры в одном чате параллельно (мафия + крокодил и т.д.). Одна и та же
                    игра дважды — всё равно нельзя.
                  </p>
                </div>
                <Switch
                  checked={s.allow_concurrent_games ?? false}
                  onCheckedChange={(v) =>
                    updateMut.mutate({ chat_id: chat.id, allow_concurrent_games: v })
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>/endgame для всех</Label>
                  <p className="text-xs text-muted-foreground">
                    Любой мембер может прервать игру через <code>/endgame</code>. Если выкл — только
                    админы Telegram-чата (EB).
                  </p>
                </div>
                <Switch
                  checked={s.allow_member_endgame ?? false}
                  onCheckedChange={(v) =>
                    updateMut.mutate({ chat_id: chat.id, allow_member_endgame: v })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Тишина до вброса (мин)</Label>
                <Input
                  type="number"
                  min={5}
                  max={1440}
                  defaultValue={s.silence_threshold_min ?? 45}
                  onBlur={(e) =>
                    updateMut.mutate({
                      chat_id: chat.id,
                      silence_threshold_min: Number(e.target.value),
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Quiet hours start (UTC)</Label>
                <Select
                  value={s.quiet_start != null ? String(s.quiet_start) : "none"}
                  onValueChange={(v) =>
                    updateMut.mutate({
                      chat_id: chat.id,
                      quiet_start: v === "none" ? null : Number(v),
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Off</SelectItem>
                    {Array.from({ length: 24 }).map((_, h) => (
                      <SelectItem key={h} value={String(h)}>
                        {h.toString().padStart(2, "0")}:00
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Quiet hours end (UTC)</Label>
                <Select
                  value={s.quiet_end != null ? String(s.quiet_end) : "none"}
                  onValueChange={(v) =>
                    updateMut.mutate({
                      chat_id: chat.id,
                      quiet_end: v === "none" ? null : Number(v),
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Off</SelectItem>
                    {Array.from({ length: 24 }).map((_, h) => (
                      <SelectItem key={h} value={String(h)}>
                        {h.toString().padStart(2, "0")}:00
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="md:col-span-2 space-y-1">
                <Label>Тон бота</Label>
                <Textarea
                  defaultValue={s.tone}
                  rows={2}
                  onBlur={(e) => updateMut.mutate({ chat_id: chat.id, tone: e.target.value })}
                />
              </div>
              <div className="md:col-span-2">
                <ChatFeatureToggles chatId={chat.id} />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
