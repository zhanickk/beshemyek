ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS ignore_messages_before timestamptz;
