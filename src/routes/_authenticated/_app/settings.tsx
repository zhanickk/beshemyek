import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getWebhookInfo, setBotWebhook, getBotInfo } from "@/lib/bot.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { CheckCircle2, AlertCircle } from "lucide-react";

export const Route = createFileRoute("/_authenticated/_app/settings")({
  head: () => ({ meta: [{ title: "Settings · Chatkeeper" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const info = useServerFn(getWebhookInfo);
  const bot = useServerFn(getBotInfo);
  const setHook = useServerFn(setBotWebhook);

  const { data: webhook, refetch } = useQuery({ queryKey: ["webhook"], queryFn: () => info() });
  const { data: botInfo } = useQuery({ queryKey: ["bot-info"], queryFn: () => bot() });

  const [url, setUrl] = useState("");
  useEffect(() => {
    if (typeof window !== "undefined") {
      const host = window.location.host;
      // Use stable project dev URL pattern
      const stable = host.replace(/^id-preview--/, "project--").replace(/\.lovable\.app$/, "-dev.lovable.app");
      setUrl(`https://${stable}/api/public/telegram/webhook`);
    }
  }, []);

  const setMut = useMutation({
    mutationFn: () => setHook({ data: { url } }),
    onSuccess: () => { toast.success("Webhook registered"); refetch(); },
    onError: (e: any) => toast.error(e.message),
  });

  const isSet = webhook?.url && webhook.url.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Connect Telegram and review bot status.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bot identity</CardTitle>
          <CardDescription>From the connected Telegram bot account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {botInfo ? (
            <>
              <p><strong>Name:</strong> {botInfo.first_name}</p>
              <p><strong>Username:</strong> @{botInfo.username}</p>
            </>
          ) : (
            <p className="text-muted-foreground">Loading bot info…</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Webhook
            {isSet ? (
              <Badge variant="default" className="gap-1"><CheckCircle2 className="w-3 h-3" /> Active</Badge>
            ) : (
              <Badge variant="outline" className="gap-1"><AlertCircle className="w-3 h-3" /> Not set</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Telegram needs to know where to send updates. Click "Set webhook" once after deploy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label>Webhook URL</Label>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button onClick={() => setMut.mutate()} disabled={!url}>Set webhook</Button>
          {webhook && (
            <div className="text-xs text-muted-foreground pt-2 border-t space-y-1">
              <p><strong>Current URL:</strong> {webhook.url || <em>none</em>}</p>
              <p><strong>Pending updates:</strong> {webhook.pending_update_count ?? 0}</p>
              {webhook.last_error_message && (
                <p className="text-destructive"><strong>Last error:</strong> {webhook.last_error_message}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>How to add the bot to a group</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>1. In Telegram, open your group → ⋮ → <strong>Add members</strong>.</p>
          <p>2. Search <strong>@{botInfo?.username ?? "your bot"}</strong> and add it.</p>
          <p>3. Promote the bot to admin (so it can see all messages, not just commands directed at it).</p>
          <p>4. The bot will post a welcome message and start engaging right away.</p>
        </CardContent>
      </Card>
    </div>
  );
}
