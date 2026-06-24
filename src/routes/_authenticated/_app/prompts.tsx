import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listPrompts, upsertPrompt, deletePrompt } from "@/lib/bot.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/_app/prompts")({
  head: () => ({ meta: [{ title: "Prompts · Chatkeeper" }] }),
  component: PromptsPage,
});

function PromptsPage() {
  const list = useServerFn(listPrompts);
  const upsert = useServerFn(upsertPrompt);
  const del = useServerFn(deletePrompt);
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [category, setCategory] = useState("icebreaker");

  const { data } = useQuery({ queryKey: ["prompts"], queryFn: () => list() });

  const refresh = () => qc.invalidateQueries({ queryKey: ["prompts"] });

  const create = useMutation({
    mutationFn: () => upsert({ data: { text, category, is_active: true } }),
    onSuccess: () => { setText(""); refresh(); toast.success("Added"); },
    onError: (e: any) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: (p: any) => upsert({ data: { id: p.id, text: p.text, category: p.category, is_active: !p.is_active } }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => { refresh(); toast.success("Deleted"); },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Prompt library</h1>
        <p className="text-muted-foreground">Conversation starters the bot will rotate through.</p>
      </div>
      <Card>
        <CardHeader><CardTitle>Add a prompt</CardTitle></CardHeader>
        <CardContent className="flex gap-2">
          <Input
            placeholder="What's a small win you had this week?"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Input
            placeholder="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-40"
          />
          <Button onClick={() => create.mutate()} disabled={text.length < 3}>
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        </CardContent>
      </Card>
      <div className="space-y-2">
        {data?.map((p: any) => (
          <div key={p.id} className="flex items-center gap-3 p-3 border rounded-lg bg-card">
            <Switch checked={p.is_active} onCheckedChange={() => toggle.mutate(p)} />
            <div className="flex-1">
              <p className={p.is_active ? "" : "text-muted-foreground line-through"}>{p.text}</p>
              <p className="text-xs text-muted-foreground">{p.category}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => remove.mutate(p.id)}>
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
