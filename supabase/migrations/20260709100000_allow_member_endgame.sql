ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS allow_member_endgame boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bot_settings.allow_member_endgame IS
  'When true, any chat member can use /endgame; when false, only Telegram chat admins.';
