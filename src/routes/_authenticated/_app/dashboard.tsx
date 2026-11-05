import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getStats, getBotInfo } from "@/lib/bot.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageCircle, Sparkles, Bot, Activity } from "lucide-react";
import { OnboardingGuide } from "@/components/OnboardingGuide";

export const Route = createFileRoute("/_authenticated/_app/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard · Chatkeeper" }] }),
  component: Dashboard,
});

function Dashboard() {
  const stats = useServerFn(getStats);
  const bot = useServerFn(getBotInfo);
  const { data } = useQuery({ queryKey: ["stats"], queryFn: () => stats() });
  const { data: botInfo } = useQuery({ queryKey: ["bot-info"], queryFn: () => bot() });

  const cards = [
    { label: "Active chats", value: data?.activeChats ?? "—", icon: MessageCircle },
    { label: "Messages today", value: data?.messagesToday ?? "—", icon: Activity },
    { label: "Prompts sent today", value: data?.promptsToday ?? "—", icon: Sparkles },
    { label: "AI replies today", value: data?.aiRepliesToday ?? "—", icon: Bot },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">
          {botInfo?.username ? (
            <>
              Connected as <strong>@{botInfo.username}</strong>
            </>
          ) : (
            "Telegram bot overview"
          )}
        </p>
      </div>

      <OnboardingGuide />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.label}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {c.label}
                </CardTitle>
                <Icon className="w-4 h-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{c.value}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
