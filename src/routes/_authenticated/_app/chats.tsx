import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listChats,
  updateChatSettings,
  sendPromptNow,
  listChatFeatures,
  setChatFeature,
  setBotPaused,
  sendBotChatMessage,
  removeChat,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Moon, Send, Sun, Trash2 } from "lucide-react";

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

function BotMessageSender({ chatId }: { chatId: string }) {
  const send = useServerFn(sendBotChatMessage);
  const [instruction, setInstruction] = useState("");
  const mut = useMutation({
    mutationFn: () => send({ data: { chat_id: chatId, instruction: instruction.trim() } }),
    onSuccess: () => {
      toast.success("Бот отправил сообщение в чат");
      setInstruction("");
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="md:col-span-2 space-y-2 border rounded-lg px-3 py-3">
      <Label>Сообщение через бота</Label>
      <p className="text-xs text-muted-foreground">
        Напиши, что отправить — Бешемьек сформулирует и кинет в чат. Например: «напомните про
        собрание в 19:00» или «го на мафию сегодня вечером».
      </p>
      <Textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        rows={2}
        placeholder="напомните про..."
      />
      <Button
        size="sm"
        disabled={!instruction.trim() || mut.isPending}
        onClick={() => mut.mutate()}
      >
        <Send className="w-3 h-3 mr-2" />
        Отправить в чат
      </Button>
    </div>
  );
}

function RemoveChatButton({
  chatId,
  title,
  onRemoved,
}: {
  chatId: string;
  title: string;
  onRemoved: () => void;
}) {
  const remove = useServerFn(removeChat);
  const mut = useMutation({
    mutationFn: () => remove({ data: { chat_id: chatId } }),
    onSuccess: () => {
      toast.success("Чат убран из списка");
      onRemoved();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive">
          <Trash2 className="w-3 h-3 mr-2" />
          Убрать чат
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Убрать «{title}»?</AlertDialogTitle>
          <AlertDialogDescription>
            Чат исчезнет из дашборда и бот перестанет его обрабатывать. Активные игры в этом чате
            будут отменены. Если снова добавишь бота в группу — чат вернётся автоматически.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction onClick={() => mut.mutate()} disabled={mut.isPending}>
            Убрать
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ChatsPage() {
  const list = useServerFn(listChats);
  const update = useServerFn(updateChatSettings);
  const send = useServerFn(sendPromptNow);
  const setPause = useServerFn(setBotPaused);
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

  const pauseMut = useMutation({
    mutationFn: (vars: { chat_id: string; is_paused: boolean; silent: boolean }) =>
      setPause({ data: vars }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["chats"] });
      if (vars.silent) {
        toast.success(vars.is_paused ? "Тихая пауза включена" : "Тихая пауза выключена");
      } else {
        toast.success(vars.is_paused ? "Бот уснул — сообщение в чат" : "Бот проснулся — сообщение в чат");
      }
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
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => sendMut.mutate(chat.telegram_chat_id)}
                  >
                    <Send className="w-3 h-3 mr-2" /> Send prompt now
                  </Button>
                  <RemoveChatButton
                    chatId={chat.id}
                    title={chat.title ?? "Untitled chat"}
                    onRemoved={() => qc.invalidateQueries({ queryKey: ["chats"] })}
                  />
                </div>
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
                <div>
                  <Label>Тихая пауза</Label>
                  <p className="text-xs text-muted-foreground">
                    Вкл/выкл без сообщений в чат.
                  </p>
                </div>
                <Switch
                  checked={s.is_paused ?? false}
                  disabled={pauseMut.isPending}
                  onCheckedChange={(v) =>
                    pauseMut.mutate({ chat_id: chat.id, is_paused: v, silent: true })
                  }
                />
              </div>
              <div className="md:col-span-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border rounded-lg px-3 py-3">
                <div>
                  <Label>Громкая пауза</Label>
                  <p className="text-xs text-muted-foreground">
                    Сообщение в чат: «пошёл спатьки» / «проснулся, го играть». Только через дашборд.
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pauseMut.isPending || (s.is_paused ?? false)}
                    onClick={() =>
                      pauseMut.mutate({ chat_id: chat.id, is_paused: true, silent: false })
                    }
                  >
                    <Moon className="w-3 h-3 mr-2" />
                    Усыпить
                  </Button>
                  <Button
                    size="sm"
                    disabled={pauseMut.isPending || !(s.is_paused ?? false)}
                    onClick={() =>
                      pauseMut.mutate({ chat_id: chat.id, is_paused: false, silent: false })
                    }
                  >
                    <Sun className="w-3 h-3 mr-2" />
                    Разбудить
                  </Button>
                </div>
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
              <div className="flex items-center justify-between">
                <div>
                  <Label>Авто-чекин</Label>
                  <p className="text-xs text-muted-foreground">
                    Бот сам запускает чекин А/Б по расписанию (раз в ~6 часов). Выключи, если
                    достаёт — команда <code>/checkin</code> и ответы на неё продолжат работать.
                  </p>
                </div>
                <Switch
                  checked={s.auto_checkin_enabled ?? true}
                  onCheckedChange={(v) =>
                    updateMut.mutate({ chat_id: chat.id, auto_checkin_enabled: v })
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
                <BotMessageSender chatId={chat.id} />
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
