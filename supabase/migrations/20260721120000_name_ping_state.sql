ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS name_ping_state jsonb;

COMMENT ON COLUMN public.bot_settings.name_ping_state IS
  'Tracks informal «бешемек» name-call DM thread in group (partner user id + idle counter).';
