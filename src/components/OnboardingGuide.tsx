import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  getBotInfo,
  getWebhookInfo,
  setBotWebhook,
  listChats,
} from "@/lib/bot.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, Circle, Copy, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";

type StepKey = "botfather" | "connector" | "webhook" | "addgroup" | "configure" | "test";

const T = {
  title: "Запуск бота",
  subtitle: "Пройдите шаги, чтобы бот заработал в вашем чате",
  done: "Готово",
  pending: "Ожидает",
  progress: (n: number, total: number) => `Выполнено ${n} из ${total}`,
  hideDone: "Скрыть",
  showAgain: "Показать инструкцию снова",
  complete: "Настройка завершена",
  steps: {
    botfather: {
      title: "1. Создать бота в BotFather",
      desc: "Получите токен от Telegram и отключите privacy mode.",
      body: (
        <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
          <li>
            Откройте{" "}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline inline-flex items-center gap-1"
            >
              @BotFather <ExternalLink className="w-3 h-3" />
            </a>{" "}
            в Telegram.
          </li>
          <li>
            Отправьте <code className="px-1 py-0.5 rounded bg-muted">/newbot</code>, выберите имя и username
            (должен заканчиваться на <code>bot</code>).
          </li>
          <li>
            Скопируйте токен вида <code>123456:ABC-DEF…</code> — он нужен для следующего шага.
          </li>
          <li>
            Отправьте <code className="px-1 py-0.5 rounded bg-muted">/setprivacy</code> → выберите бота →
            нажмите <strong>Disable</strong> (чтобы бот видел все сообщения в группе).
          </li>
        </ol>
      ),
    },
    connector: {
      title: "2. Настроить токен бота",
      desc: "Добавьте TELEGRAM_API_KEY в секреты Cloudflare Worker (или .dev.vars локально).",
    },
    webhook: {
      title: "3. Установить webhook",
      desc: "Это связывает Telegram с вашим приложением, чтобы бот получал сообщения.",
    },
    addgroup: {
      title: "4. Добавить бота в группу",
      desc: "Сделайте бота администратором группы.",
    },
    configure: {
      title: "5. Настроить чат",
      desc: "Выберите функции, язык и расписание для каждого чата.",
    },
    test: {
      title: "6. Проверить работу",
      desc: "Попробуйте команды в группе.",
    },
  },
};

export function OnboardingGuide() {
  const botFn = useServerFn(getBotInfo);
  const hookFn = useServerFn(getWebhookInfo);
  const setHook = useServerFn(setBotWebhook);
  const chatsFn = useServerFn(listChats);

  const botQ = useQuery({
    queryKey: ["onb-bot"],
    queryFn: () => botFn(),
    retry: false,
    staleTime: 30_000,
  });
  const hookQ = useQuery({
    queryKey: ["onb-hook"],
    queryFn: () => hookFn(),
    retry: false,
    staleTime: 30_000,
  });
  const chatsQ = useQuery({
    queryKey: ["onb-chats"],
    queryFn: () => chatsFn(),
    retry: false,
    staleTime: 30_000,
  });

  const connectorLinked = !!botQ.data?.username;
  const botUsername: string | null = botQ.data?.username ?? null;
  const webhookActive = !!hookQ.data?.url;
  const chatsCount = chatsQ.data?.length ?? 0;
  const hasChats = chatsCount > 0;

  // Heuristic: if connector + webhook are working, assume BotFather was used.
  const [manualBotfather, setManualBotfather] = useState(false);
  const botfatherDone = connectorLinked || manualBotfather;

  const [manualAddGroup, setManualAddGroup] = useState(false);
  const addGroupDone = hasChats || manualAddGroup;

  const [manualConfigure, setManualConfigure] = useState(false);
  const configureDone = hasChats && (manualConfigure || chatsCount > 0);

  const [manualTest, setManualTest] = useState(false);
  const testDone = manualTest;

  const statuses: Record<StepKey, boolean> = {
    botfather: botfatherDone,
    connector: connectorLinked,
    webhook: webhookActive,
    addgroup: addGroupDone,
    configure: configureDone,
    test: testDone,
  };

  const total = 6;
  const doneCount = Object.values(statuses).filter(Boolean).length;
  const allDone = doneCount === total;
  const [forceShow, setForceShow] = useState(false);

  const webhookUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/api/public/telegram/webhook`;
  }, []);

  const setHookMut = useMutation({
    mutationFn: () => setHook({ data: { url: webhookUrl } }),
    onSuccess: () => {
      toast.success("Webhook установлен");
      hookQ.refetch();
    },
    onError: (e: any) => toast.error(e?.message ?? "Не удалось установить webhook"),
  });

  if (allDone && !forceShow) {
    return (
      <Card className="border-green-500/40 bg-green-500/5">
        <CardContent className="flex items-center justify-between py-4">
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-5 h-5 text-green-500" />
            <span className="font-medium">{T.complete}</span>
            <Badge variant="secondary">{T.progress(doneCount, total)}</Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setForceShow(true)}>
            {T.showAgain}
            <ChevronDown className="w-4 h-4 ml-1" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>{T.title}</CardTitle>
            <CardDescription>{T.subtitle}</CardDescription>
          </div>
          {allDone && (
            <Button variant="ghost" size="sm" onClick={() => setForceShow(false)}>
              {T.hideDone}
              <ChevronUp className="w-4 h-4 ml-1" />
            </Button>
          )}
        </div>
        <div className="pt-2 space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{T.progress(doneCount, total)}</span>
            <span>{Math.round((doneCount / total) * 100)}%</span>
          </div>
          <Progress value={(doneCount / total) * 100} />
        </div>
      </CardHeader>
      <CardContent>
        <Accordion type="single" collapsible defaultValue={firstPending(statuses)}>
          {/* Step 1: BotFather */}
          <StepItem
            id="botfather"
            done={statuses.botfather}
            title={T.steps.botfather.title}
            desc={T.steps.botfather.desc}
          >
            {T.steps.botfather.body}
            {!botfatherDone && (
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setManualBotfather(true)}>
                Готово, продолжить
              </Button>
            )}
          </StepItem>

          {/* Step 2: Connector */}
          <StepItem
            id="connector"
            done={statuses.connector}
            title={T.steps.connector.title}
            desc={T.steps.connector.desc}
          >
            <p className="text-sm text-muted-foreground mb-3">
              Добавьте переменную <code className="px-1 py-0.5 rounded bg-muted">TELEGRAM_API_KEY</code> с
              токеном от BotFather в секреты Cloudflare Worker. Локально — в файл{" "}
              <code className="px-1 py-0.5 rounded bg-muted">.dev.vars</code>.
            </p>
            {connectorLinked ? (
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                Токен настроен, бот: <strong>@{botUsername}</strong>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-destructive">
                  Токен не настроен или невалиден — проверьте TELEGRAM_API_KEY.
                </p>
                <Button size="sm" variant="outline" onClick={() => botQ.refetch()}>
                  Проверить снова
                </Button>
              </div>
            )}
          </StepItem>

          {/* Step 3: Webhook */}
          <StepItem
            id="webhook"
            done={statuses.webhook}
            title={T.steps.webhook.title}
            desc={T.steps.webhook.desc}
          >
            <div className="space-y-3">
              <div className="text-xs font-mono p-2 rounded bg-muted break-all">{webhookUrl}</div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => setHookMut.mutate()}
                  disabled={!webhookUrl || setHookMut.isPending}
                >
                  {webhookActive ? "Переустановить webhook" : "Установить webhook"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => hookQ.refetch()}>
                  Проверить статус
                </Button>
              </div>
              {hookQ.data?.last_error_message && (
                <p className="text-xs text-destructive">
                  Последняя ошибка от Telegram: {hookQ.data.last_error_message}
                </p>
              )}
              {webhookActive && (
                <p className="text-xs text-muted-foreground">
                  Активен: {hookQ.data?.url}
                </p>
              )}
            </div>
          </StepItem>

          {/* Step 4: Add to group */}
          <StepItem
            id="addgroup"
            done={statuses.addgroup}
            title={T.steps.addgroup.title}
            desc={T.steps.addgroup.desc}
          >
            <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
              <li>Откройте свою группу → меню → «Добавить участника».</li>
              <li>
                Найдите бота по username и добавьте:
                {botUsername ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-2 h-7"
                    onClick={() => {
                      navigator.clipboard.writeText(`@${botUsername}`);
                      toast.success("Username скопирован");
                    }}
                  >
                    <Copy className="w-3 h-3 mr-1" />@{botUsername}
                  </Button>
                ) : (
                  <span className="ml-1 text-destructive">сначала настройте TELEGRAM_API_KEY</span>
                )}
              </li>
              <li>
                Сделайте его <strong>администратором</strong> — иначе он не сможет видеть все сообщения и
                писать в группу корректно.
              </li>
              <li>
                Бот пришлёт приветственное сообщение — после этого группа появится в разделе{" "}
                <Link to="/chats" className="text-primary underline">
                  Chats
                </Link>
                .
              </li>
            </ol>
            <div className="mt-3 flex items-center gap-2">
              <Badge variant={hasChats ? "default" : "outline"}>
                Подключено чатов: {chatsCount}
              </Badge>
              <Button size="sm" variant="ghost" onClick={() => chatsQ.refetch()}>
                Обновить
              </Button>
              {!hasChats && (
                <Button size="sm" variant="outline" onClick={() => setManualAddGroup(true)}>
                  Я добавил, скрыть
                </Button>
              )}
            </div>
          </StepItem>

          {/* Step 5: Configure */}
          <StepItem
            id="configure"
            done={statuses.configure}
            title={T.steps.configure.title}
            desc={T.steps.configure.desc}
          >
            <p className="text-sm text-muted-foreground mb-3">
              В разделе <Link to="/chats" className="text-primary underline">Chats</Link> для каждого чата
              можно включить:
            </p>
            <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
              <li>Ежедневные icebreaker'ы (с выбором часа отправки)</li>
              <li>Ответы AI на @упоминания и реплаи</li>
              <li>Викторины и опросы (<code>/trivia</code>, <code>/poll</code>)</li>
              <li>Язык: Авто / Русский / English</li>
            </ul>
            {hasChats && (
              <Button size="sm" variant="outline" className="mt-3" onClick={() => setManualConfigure(true)}>
                Готово
              </Button>
            )}
          </StepItem>

          {/* Step 6: Test */}
          <StepItem
            id="test"
            done={statuses.test}
            title={T.steps.test.title}
            desc={T.steps.test.desc}
          >
            <p className="text-sm text-muted-foreground mb-2">Отправьте в группе любую из команд:</p>
            <div className="space-y-2">
              {[
                { cmd: "/icebreaker", hint: "случайный вопрос для разговора" },
                { cmd: "/trivia", hint: "мини-викторина" },
                { cmd: "/poll Любимый кофе? | Эспрессо | Капучино | Латте", hint: "свой опрос" },
                { cmd: botUsername ? `@${botUsername} привет!` : "@your_bot привет!", hint: "AI-ответ" },
              ].map((row) => (
                <div key={row.cmd} className="flex items-center justify-between gap-2 text-sm">
                  <code className="px-2 py-1 rounded bg-muted text-xs break-all">{row.cmd}</code>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-muted-foreground text-xs hidden sm:inline">{row.hint}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(row.cmd);
                        toast.success("Скопировано");
                      }}
                    >
                      <Copy className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Активность бота видна в разделе{" "}
              <Link to="/activity" className="text-primary underline">
                Activity
              </Link>
              .
            </p>
            <Button size="sm" className="mt-3" onClick={() => setManualTest(true)}>
              Всё работает
            </Button>
          </StepItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}

function firstPending(s: Record<StepKey, boolean>): string {
  const order: StepKey[] = ["botfather", "connector", "webhook", "addgroup", "configure", "test"];
  return order.find((k) => !s[k]) ?? "test";
}

function StepItem({
  id,
  done,
  title,
  desc,
  children,
}: {
  id: string;
  done: boolean;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <AccordionItem value={id}>
      <AccordionTrigger className="hover:no-underline">
        <div className="flex items-center gap-3 text-left">
          {done ? (
            <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
          ) : (
            <Circle className="w-5 h-5 text-muted-foreground shrink-0" />
          )}
          <div>
            <div className="font-medium">{title}</div>
            <div className="text-xs text-muted-foreground">{desc}</div>
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent className="pl-8">{children}</AccordionContent>
    </AccordionItem>
  );
}
