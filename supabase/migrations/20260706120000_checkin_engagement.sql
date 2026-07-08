-- Check-in sessions (A/B dilemmas with member rotation) + engagement tracking columns.

ALTER TABLE public.chat_members
  ADD COLUMN IF NOT EXISTS last_checkin_tagged_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_checkin_answered_at timestamptz;

ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS next_checkin_at timestamptz;

CREATE TABLE IF NOT EXISTS public.checkin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active', -- active | finished
  question text NOT NULL,
  option_a text NOT NULL,
  option_b text NOT NULL,
  target_user_id bigint NOT NULL,
  tagged_user_ids bigint[] NOT NULL DEFAULT '{}',
  answered_user_ids bigint[] NOT NULL DEFAULT '{}',
  relay_mode text NOT NULL DEFAULT 'same_question', -- same_question | new_question
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.checkin_sessions TO authenticated;
GRANT ALL ON public.checkin_sessions TO service_role;
ALTER TABLE public.checkin_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read checkin_sessions" ON public.checkin_sessions FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
CREATE INDEX IF NOT EXISTS checkin_sessions_chat_status_idx ON public.checkin_sessions(chat_id, status);
CREATE TRIGGER checkin_sessions_updated_at BEFORE UPDATE ON public.checkin_sessions
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
