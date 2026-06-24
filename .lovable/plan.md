## Цель
Помочь новому админу запустить бота за 6 шагов прямо из дашборда, без внешней документации.

## Что добавим

### 1. Новый компонент `src/components/OnboardingGuide.tsx`
Пошаговый чек-лист с прогрессом:
1. **Создать бота в BotFather** — внешняя ссылка на `https://t.me/BotFather`, краткая инструкция (`/newbot`, `/setprivacy → Disable`).
2. **Подключить Telegram-коннектор** — статус: подключен/не подключен (определяем по успешности `getBotInfo` server fn). Если нет — кнопка «Открыть Connectors».
3. **Установить webhook** — кнопка «Set webhook» (переиспользует существующий server fn из Settings). Показывает статус активности.
4. **Добавить бота в группу** — инструкция + поле «Username бота» (подтягивается из `getMe`), кнопка «Скопировать username».
5. **Настроить чат** — ссылка на раздел Chats, счётчик подключенных чатов.
6. **Проверить работу** — список команд (`/icebreaker`, `/trivia`, `/poll`, `@mention`) с возможностью скопировать.

Каждый шаг:
- Иконка статуса (○ ожидает / ✓ выполнено)
- Сворачиваемая карточка (Accordion из shadcn)
- Автоматическое определение выполнения, где возможно (webhook активен, есть чаты, коннектор подключен)

### 2. Server function `src/lib/onboarding.functions.ts`
`getOnboardingStatus` — возвращает:
```ts
{
  connectorLinked: boolean,   // есть ли TELEGRAM_API_KEY и отвечает ли getMe
  botUsername: string | null,
  webhookActive: boolean,     // через getWebhookInfo
  chatsCount: number,
}
```
Использует `requireSupabaseAuth` + проверку роли admin.

### 3. Интеграция в дашборд
- На странице `src/routes/_authenticated/_app/dashboard.tsx`: показывать `<OnboardingGuide />` сверху, **пока не выполнены все шаги**. После — сворачивается в маленький баннер «Setup complete ✓» с возможностью развернуть снова.
- Локализация: RU/EN, определяется по `navigator.language` (или фиксируем RU, раз пользователь общается на русском — уточнить можно позже).

### 4. Мелочи UI
- Используем существующие shadcn-компоненты: `Card`, `Accordion`, `Button`, `Badge`, `Progress`.
- Прогресс-бар сверху: `выполнено N из 6`.
- Toast при успешной установке webhook (уже есть в Settings — переиспользуем хук).

## Что НЕ трогаем
- Логику бота, webhook-handler, БД, prompts, cron — без изменений.
- Только UI + одна read-only server fn.

## Технические детали
- `getOnboardingStatus` кэшируется через TanStack Query с `staleTime: 30s`, инвалидируется после нажатия «Set webhook».
- `getMe` через connector gateway уже доступен в `telegram.server.ts` — добавим обёртку, если её нет.
- Все ключи переводов — в существующем словаре `T` из `telegram.server.ts` не пойдут (это серверный), для UI заведём маленький объект прямо в компоненте.
