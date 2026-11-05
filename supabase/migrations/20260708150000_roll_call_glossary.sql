-- Fix Roll Call definition in quiz bank (dance video tradition, not a call/meeting).
UPDATE public.quiz_questions
SET
  options = '["Созвон всей локалки перед LCM", "Танец локалки под видео с музыкой от айсекеров мира", "Отчёт по KPI", "Перекличка на паре"]'::jsonb,
  correct_option = 1
WHERE category = 'aiesec'
  AND language = 'ru'
  AND question = 'Что такое Roll Call?';

UPDATE public.quiz_questions
SET options = '["Веду собрание и раздаю задачи", "Зажигаю на Roll Call в первых рядах", "Кидаю мемы в чат весь LCM", "Тихо делаю заметки и всё выполняю"]'::jsonb
WHERE category = 'archetype'
  AND language = 'ru'
  AND question = 'На LCM ты обычно...';
