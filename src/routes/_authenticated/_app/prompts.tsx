import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listPrompts, upsertPrompt, deletePrompt } from "@/lib/bot.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
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
  const [language, setLanguage] = useState<"en" | "ru">("en");
  const [filter, setFilter] = useState<"all" | "en" | "ru">("all");

  const { data } = useQuery({ queryKey: ["prompts"], queryFn: () => list() });

  const refresh = () => qc.invalidateQueries({ queryKey: ["prompts"] });

  const create = useMutation({
    mutationFn: () => upsert({ data: { text, category, is_active: true, language } }),
    onSuccess: () => {
      setText("");
      refresh();
      toast.success("Added");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: (p: any) =>
      upsert({
        data: {
          id: p.id,
          text: p.text,
          category: p.category,
          language: p.language ?? "en",
          is_active: !p.is_active,
        },
      }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      refresh();
      toast.success("Deleted");
    },
  });

  const visible = (data ?? []).filter(
    (p: any) => filter === "all" || (p.language ?? "en") === filter,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Prompt library</h1>
          <p className="text-muted-foreground">
            Conversation starters the bot will rotate through.
          </p>
        </div>
        <div className="w-40">
          <Select value={filter} onValueChange={(v: any) => setFilter(v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All languages</SelectItem>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="ru">Русский</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Add a prompt</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Input
            placeholder="What's a small win you had this week?"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="flex-1 min-w-[240px]"
          />
          <Input
            placeholder="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-40"
          />
          <Select value={language} onValueChange={(v: any) => setLanguage(v)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="ru">Русский</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={() => create.mutate()} disabled={text.length < 3}>
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        </CardContent>
      </Card>
      <div className="space-y-2">
        {visible.map((p: any) => (
          <div key={p.id} className="flex items-center gap-3 p-3 border rounded-lg bg-card">
            <Switch checked={p.is_active} onCheckedChange={() => toggle.mutate(p)} />
            <div className="flex-1">
              <p className={p.is_active ? "" : "text-muted-foreground line-through"}>{p.text}</p>
              <div className="flex gap-2 mt-1">
                <Badge variant="secondary" className="text-xs">
                  {p.category}
                </Badge>
                <Badge variant="outline" className="text-xs uppercase">
                  {p.language ?? "en"}
                </Badge>
              </div>
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
