import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listChats, updateChatSettings, sendPromptNow } from "@/lib/bot.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Send } from "lucide-react";

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
                <Button size="sm" variant="outline" onClick={() => sendMut.mutate(chat.telegram_chat_id)}>
                  <Send className="w-3 h-3 mr-2" /> Send prompt now
                </Button>
              </div>
            </CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-4">
              <div className="flex items-center justify-between">
                <Label>AI replies on @mention</Label>
                <Switch
                  checked={s.ai_replies_enabled}
                  onCheckedChange={(v) => updateMut.mutate({ chat_id: chat.id, ai_replies_enabled: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>Scheduled prompts</Label>
                <Switch
                  checked={s.prompts_enabled}
                  onCheckedChange={(v) => updateMut.mutate({ chat_id: chat.id, prompts_enabled: v })}
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
                  <SelectTrigger><SelectValue /></SelectTrigger>
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
                  onValueChange={(v) => updateMut.mutate({ chat_id: chat.id, prompt_hour_utc: Number(v) })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 24 }).map((_, h) => (
                      <SelectItem key={h} value={String(h)}>{h.toString().padStart(2, "0")}:00</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
