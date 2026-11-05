ALTER TABLE public.checkin_sessions
  ADD COLUMN IF NOT EXISTS initiator_user_id bigint,
  ADD COLUMN IF NOT EXISTS relay_from_user_id bigint,
  ADD COLUMN IF NOT EXISTS target_tagged_at timestamptz;

COMMENT ON COLUMN public.checkin_sessions.initiator_user_id IS
  'Telegram user who started the check-in (button or /checkin).';
COMMENT ON COLUMN public.checkin_sessions.relay_from_user_id IS
  'User to return the check-in to if the current target times out.';
COMMENT ON COLUMN public.checkin_sessions.target_tagged_at IS
  'When the current target was last tagged — used for 20s response timeout.';
