ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS auto_checkin_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.bot_settings.auto_checkin_enabled IS
  'Controls only the scheduled/random auto-checkin (runCheckinTick). Manual /checkin and the
   answer flow are governed separately by the "checkin" chat_features toggle.';
