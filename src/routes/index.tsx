import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { MessageCircle, Sparkles, Bot, BarChart3 } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Chatkeeper — A Telegram bot that keeps your group lively" },
      { name: "description", content: "Engage your Telegram community with conversation starters, AI replies, and mini-polls. Configure everything from a simple dashboard." },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <MessageCircle className="w-4 h-4 text-primary" />
            </div>
            <span className="font-semibold">Chatkeeper</span>
          </div>
          <Link to="/auth"><Button size="sm">Sign in</Button></Link>
        </div>
      </header>
      <main>
        <section className="max-w-4xl mx-auto px-6 py-20 text-center">
          <h1 className="text-5xl md:text-6xl font-bold tracking-tight">
            Keep your Telegram group <span className="text-primary">talking</span>.
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
            Chatkeeper is a friendly Telegram bot that drops in conversation starters,
            chats back when mentioned, and runs quick polls — so your community stays alive,
            even when it's quiet.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link to="/auth"><Button size="lg">Get started</Button></Link>
          </div>
        </section>
        <section className="max-w-5xl mx-auto px-6 pb-20 grid md:grid-cols-3 gap-6">
          {[
            { icon: Sparkles, title: "Daily icebreakers", body: "Scheduled prompts keep the chat warm. Customize your library or use ours." },
            { icon: Bot, title: "Kind AI replies", body: "@mention the bot and it joins in with warm, encouraging responses." },
            { icon: BarChart3, title: "Polls & trivia", body: "One command launches a poll or AI-generated trivia question." },
          ].map((f) => {
            const Icon = f.icon;
            return (
              <div key={f.title} className="p-6 rounded-xl border bg-card">
                <Icon className="w-6 h-6 text-primary mb-3" />
                <h3 className="font-semibold mb-2">{f.title}</h3>
                <p className="text-sm text-muted-foreground">{f.body}</p>
              </div>
            );
          })}
        </section>
      </main>
    </div>
  );
}
