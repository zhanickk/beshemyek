## Проблема
Webhook зарегистрирован на `https://beshemyek-dev.lovable.app/...`, который не существует (это попытка превратить опубликованный кастомный поддомен в dev-хост простой подстановкой). Стабильный dev-URL Lovable — `https://project--<project-id>-dev.lovable.app`, поэтому Telegram возвращает 404.

## Что поправить
1. В `src/routes/_authenticated/_app/settings.tsx` заменить логику вычисления `url`:
   - Использовать project id из env (`VITE_LOVABLE_PROJECT_ID`) и строить URL `https://project--${id}-dev.lovable.app/api/public/telegram/webhook`.
   - Если хост уже соответствует `project--<id>(-dev)?.lovable.app` или localhost, использовать текущий origin как есть.
   - Сделать поле URL редактируемым (Input вместо `<code>`), чтобы пользователь мог при необходимости подставить production-домен.
2. Добавить переменную `VITE_LOVABLE_PROJECT_ID=a4c96bd2-c11d-47a5-9aaa-f867b7072fa3` в `.env` (отдельно от auto-gen Supabase переменных).
3. После применения нажать «Переустановить webhook» — Telegram примет новый URL и ошибка 404 исчезнет.

## Почему не сервером
Серверный код в Worker'е не знает project id сам по себе; чтение `import.meta.env.VITE_LOVABLE_PROJECT_ID` на клиенте — самый надёжный путь без новых секретов.
