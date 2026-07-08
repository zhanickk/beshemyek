ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS allow_concurrent_games boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bot_settings.allow_concurrent_games IS
  'When true, different game types may run at the same time in one chat.';
