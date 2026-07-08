ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS tumba_digest_threshold int;
