import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listStickers, deleteSticker, importStickerFromUrl, listChats } from "@/lib/bot.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Trash2, Plus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/_app/stickers")({
  head: () => ({ meta: [{ title: "Stickers · Chatkeeper" }] }),
  component: StickersPage,
});

const CATEGORIES = ["радость", "кринж", "обида", "угар", "победа"];

function StickersPage() {
  const listFn = useServerFn(listStickers);
  const deleteFn = useServerFn(deleteSticker);
  const importFn = useServerFn(importStickerFromUrl);
  const listChatsFn = useServerFn(listChats);
  const qc = useQueryClient();

  const { data: stickers } = useQuery({ queryKey: ["stickers"], queryFn: () => listFn() });
  const { data: chats } = useQuery({ queryKey: ["chats"], queryFn: () => listChatsFn() });

  const [category, setCategory] = useState(CATEGORIES[0]);
  const [imageUrl, setImageUrl] = useState("");
  const [chatId, setChatId] = useState<string>("");

  const importMut = useMutation({
    mutationFn: () => {
      const chat = chats?.find((c: any) => c.id === (chatId || chats?.[0]?.id));
      if (!chat)
        throw new Error(
          "Add the bot to a chat first — it needs somewhere to fetch the image through.",
        );
      return importFn({
        data: { telegram_chat_id: chat.telegram_chat_id, image_url: imageUrl, category },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stickers"] });
      setImageUrl("");
      toast.success("Sticker imported!");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stickers"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Stickers</h1>
        <p className="text-muted-foreground">
          Import reaction stickers by category. Paste a public image URL — Telegram fetches it and
          hands back a reusable file_id.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Import a sticker</CardTitle>
          <CardDescription>
            Host your sticker images anywhere public (e.g. Imgur, Telegraph) and paste the direct
            link.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid md:grid-cols-4 gap-3 items-end">
          <div className="space-y-1 md:col-span-2">
            <Label>Image URL</Label>
            <Input
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div className="space-y-1">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button disabled={!imageUrl || importMut.isPending} onClick={() => importMut.mutate()}>
            <Plus className="w-4 h-4 mr-2" /> Import
          </Button>
        </CardContent>
      </Card>

      <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
        {CATEGORIES.map((cat) => (
          <Card key={cat}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base capitalize">{cat}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {stickers
                ?.filter((s: any) => s.category === cat)
                .map((s: any) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between text-xs border rounded px-2 py-1"
                  >
                    <span className="truncate font-mono">{s.file_id.slice(0, 24)}…</span>
                    <Button size="sm" variant="ghost" onClick={() => deleteMut.mutate(s.id)}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              {(!stickers || stickers.filter((s: any) => s.category === cat).length === 0) && (
                <p className="text-xs text-muted-foreground">No stickers yet.</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
