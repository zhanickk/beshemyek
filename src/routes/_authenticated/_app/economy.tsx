import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listChats,
  listLeaderboard,
  adjustMemberCoins,
  listShopItems,
  upsertShopItem,
} from "@/lib/bot.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/_app/economy")({
  head: () => ({ meta: [{ title: "Economy · Chatkeeper" }] }),
  component: EconomyPage,
});

function EconomyPage() {
  const listChatsFn = useServerFn(listChats);
  const listLeaderboardFn = useServerFn(listLeaderboard);
  const adjustCoinsFn = useServerFn(adjustMemberCoins);
  const listShopFn = useServerFn(listShopItems);
  const upsertShopFn = useServerFn(upsertShopItem);
  const qc = useQueryClient();

  const { data: chats } = useQuery({ queryKey: ["chats"], queryFn: () => listChatsFn() });
  const [chatId, setChatId] = useState<string>("");
  const activeChatId = chatId || chats?.[0]?.id || "";

  const { data: leaderboard } = useQuery({
    queryKey: ["leaderboard", activeChatId],
    queryFn: () => listLeaderboardFn({ data: { chat_id: activeChatId } }),
    enabled: !!activeChatId,
  });
  const { data: shopItems } = useQuery({ queryKey: ["shop-items"], queryFn: () => listShopFn() });

  const adjustMut = useMutation({
    mutationFn: (vars: { telegram_user_id: number; delta: number }) =>
      adjustCoinsFn({ data: { chat_id: activeChatId, ...vars } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leaderboard", activeChatId] });
      toast.success("Coins updated");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const shopMut = useMutation({
    mutationFn: (vars: any) => upsertShopFn({ data: vars }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["shop-items"] });
      toast.success("Saved");
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Economy</h1>
        <p className="text-muted-foreground">БешКоины leaderboard and shop items.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Leaderboard</CardTitle>
          <CardDescription>
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
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Coins</TableHead>
                <TableHead>Streak</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Adjust</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leaderboard?.map((m: any) => (
                <TableRow key={m.id}>
                  <TableCell>
                    {m.display_name || (m.username ? `@${m.username}` : `#${m.telegram_user_id}`)}
                  </TableCell>
                  <TableCell>{m.coins} 🪙</TableCell>
                  <TableCell>{m.streak_days}🔥</TableCell>
                  <TableCell>{m.role_tag}</TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        adjustMut.mutate({ telegram_user_id: m.telegram_user_id, delta: 10 })
                      }
                    >
                      +10
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        adjustMut.mutate({ telegram_user_id: m.telegram_user_id, delta: -10 })
                      }
                    >
                      -10
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(!leaderboard || leaderboard.length === 0) && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                    No members yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Shop items</CardTitle>
          <CardDescription>Global defaults, purchasable via /shop in any chat.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {shopItems?.map((item: any) => (
            <div key={item.id} className="flex items-center gap-3 border rounded-md p-2">
              <div className="flex-1">
                <p className="font-medium text-sm">{item.title}</p>
                <p className="text-xs text-muted-foreground">{item.description}</p>
              </div>
              <Input
                type="number"
                className="w-20"
                defaultValue={item.price}
                onBlur={(e) =>
                  shopMut.mutate({
                    id: item.id,
                    key: item.key,
                    title: item.title,
                    description: item.description,
                    price: Number(e.target.value),
                    is_active: item.is_active,
                  })
                }
              />
              <div className="flex items-center gap-1">
                <Label className="text-xs">Active</Label>
                <Switch
                  checked={item.is_active}
                  onCheckedChange={(v) =>
                    shopMut.mutate({
                      id: item.id,
                      key: item.key,
                      title: item.title,
                      description: item.description,
                      price: item.price,
                      is_active: v,
                    })
                  }
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
