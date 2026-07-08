ALTER TABLE public.checkin_sessions
  ADD COLUMN IF NOT EXISTS pending_choice text,
  ADD COLUMN IF NOT EXISTS prompt_message_id bigint;
