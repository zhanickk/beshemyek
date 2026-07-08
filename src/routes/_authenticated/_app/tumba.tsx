import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listTumbaQueue, moderateTumbaMessage } from "@/lib/bot.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Check, Ban } from "lucide-react";

export const Route = createFileRoute("/_authenticated/_app/tumba")({
  head: () => ({ meta: [{ title: "Tumba · Chatkeeper" }] }),
  component: TumbaPage,
});

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  approved: "outline",
  blocked: "destructive",
  posted: "default",
};

function TumbaPage() {
  const listFn = useServerFn(listTumbaQueue);
  const moderateFn = useServerFn(moderateTumbaMessage);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["tumba-queue"], queryFn: () => listFn() });

  const moderateMut = useMutation({
    mutationFn: (vars: { id: string; status: "approved" | "blocked" }) =>
      moderateFn({ data: vars }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tumba-queue"] });
      toast.success("Updated");
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Tumba</h1>
        <p className="text-muted-foreground">
          Anonymous message moderation queue. Approved messages go out in the next daily digest
          (18:00 UTC).
        </p>
      </div>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && (!data || data.length === 0) && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            No Tumba messages yet.
          </CardContent>
        </Card>
      )}
      <div className="space-y-3">
        {data?.map((m: any) => (
          <Card key={m.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  {m.category} {m.to_username ? `→ @${m.to_username}` : "→ всем"}
                </CardTitle>
                <Badge variant={STATUS_VARIANT[m.status] ?? "outline"}>{m.status}</Badge>
              </div>
              <CardDescription>
                {m.chats?.title ?? "Unknown chat"} · {new Date(m.created_at).toLocaleString()}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-4">
              <p className="text-sm flex-1">{m.body}</p>
              {m.status === "pending" || m.status === "approved" ? (
                <div className="flex gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => moderateMut.mutate({ id: m.id, status: "approved" })}
                  >
                    <Check className="w-3 h-3 mr-1" /> Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => moderateMut.mutate({ id: m.id, status: "blocked" })}
                  >
                    <Ban className="w-3 h-3 mr-1" /> Block
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
