import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listActivity } from "@/lib/bot.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/_app/activity")({
  head: () => ({ meta: [{ title: "Activity · Chatkeeper" }] }),
  component: ActivityPage,
});

function ActivityPage() {
  const fn = useServerFn(listActivity);
  const { data } = useQuery({ queryKey: ["activity"], queryFn: () => fn(), refetchInterval: 10000 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Activity</h1>
        <p className="text-muted-foreground">Recent messages and bot replies.</p>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle>Incoming messages</CardTitle></CardHeader>
          <CardContent className="space-y-2 max-h-[600px] overflow-auto">
            {data?.messages.length === 0 && <p className="text-sm text-muted-foreground">No messages yet.</p>}
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
          <CardHeader><CardTitle>Bot sends</CardTitle></CardHeader>
          <CardContent className="space-y-2 max-h-[600px] overflow-auto">
            {data?.sends.length === 0 && <p className="text-sm text-muted-foreground">No sends yet.</p>}
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
