import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listActivity, listChats, listMemberActivity } from "@/lib/bot.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/_app/activity")({
  head: () => ({ meta: [{ title: "Activity · Chatkeeper" }] }),
  component: ActivityPage,
});

function memberName(m: any) {
  return m.display_name || (m.username ? `@${m.username}` : `#${m.telegram_user_id}`);
}

function MemberActivityTracker() {
  const listChatsFn = useServerFn(listChats);
  const listMemberActivityFn = useServerFn(listMemberActivity);
  const { data: chats } = useQuery({ queryKey: ["chats"], queryFn: () => listChatsFn() });
  const [chatId, setChatId] = useState<string>("");
  const activeChatId = chatId || chats?.[0]?.id || "";

  const { data } = useQuery({
    queryKey: ["member-activity", activeChatId],
    queryFn: () => listMemberActivityFn({ data: { chat_id: activeChatId } }),
    enabled: !!activeChatId,
    refetchInterval: 30000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Member activity tracker</CardTitle>
        <CardDescription>
          Who carries the chat and who's gone quiet.
          <Select value={activeChatId} onValueChange={setChatId}>
            <SelectTrigger className="w-64 mt-2">
              <SelectValue placeholder="Select a chat" />
            </SelectTrigger>
            <SelectContent>
              {chats?.map((c: any) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title ?? "Untitled"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardDescription>
      </CardHeader>
      <CardContent className="grid md:grid-cols-2 gap-6">
        <div>
          <h3 className="text-sm font-semibold mb-2">🔥 Most active</h3>
          <div className="space-y-1">
            {data?.mostActive.map((m: any) => (
              <div
                key={m.telegram_user_id}
                className="flex items-center justify-between text-sm border-b pb-1 last:border-0"
              >
                <span>{memberName(m)}</span>
                <span className="text-muted-foreground">{m.message_count} msg</span>
              </div>
            ))}
            {(!data || data.mostActive.length === 0) && (
              <p className="text-sm text-muted-foreground">No members yet.</p>
            )}
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-2">😴 Quietest lately</h3>
          <div className="space-y-1">
            {data?.quietest.map((m: any) => (
              <div
                key={m.telegram_user_id}
                className="flex items-center justify-between text-sm border-b pb-1 last:border-0"
              >
                <span>{memberName(m)}</span>
                <span className="text-muted-foreground">
                  {m.last_active_at
                    ? formatDistanceToNow(new Date(m.last_active_at), { addSuffix: true })
                    : "never"}
                </span>
              </div>
            ))}
            {(!data || data.quietest.length === 0) && (
              <p className="text-sm text-muted-foreground">No members yet.</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ActivityPage() {
  const fn = useServerFn(listActivity);
  const { data } = useQuery({
    queryKey: ["activity"],
    queryFn: () => fn(),
    refetchInterval: 10000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Activity</h1>
        <p className="text-muted-foreground">Recent messages and bot replies.</p>
      </div>

      <MemberActivityTracker />
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Incoming messages</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 max-h-[600px] overflow-auto">
            {data?.messages.length === 0 && (
              <p className="text-sm text-muted-foreground">No messages yet.</p>
            )}
            {data?.messages.map((m: any) => (
              <div key={m.update_id} className="text-sm border-b pb-2 last:border-0">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">{m.kind}</Badge>
                  <span>@{m.from_username ?? m.from_user_id}</span>
                  <span>· {formatDistanceToNow(new Date(m.created_at), { addSuffix: true })}</span>
                </div>
                <p className="mt-1">{m.text ?? <em>(non-text)</em>}</p>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Bot sends</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 max-h-[600px] overflow-auto">
            {data?.sends.length === 0 && (
              <p className="text-sm text-muted-foreground">No sends yet.</p>
            )}
            {data?.sends.map((s: any) => (
              <div key={s.id} className="text-sm border-b pb-2 last:border-0">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge>{s.kind}</Badge>
                  <span>{formatDistanceToNow(new Date(s.sent_at), { addSuffix: true })}</span>
                </div>
                <p className="mt-1">{s.content}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
