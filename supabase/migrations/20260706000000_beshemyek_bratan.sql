-- Beshemyek Bratan: personality, engagement, games, economy, Tumba, shipping.
-- Extends the existing chats/bot_settings/prompts/messages_log/bot_sends/polls schema.

-- ── bot_settings additions ──────────────────────────────────────────────
ALTER TABLE public.bot_settings
  ADD COLUMN IF NOT EXISTS is_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paused_until timestamptz,
  ADD COLUMN IF NOT EXISTS silence_threshold_min int NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS next_engagement_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_bot_message_at timestamptz,
  ADD COLUMN IF NOT EXISTS ignored_pout_sent boolean NOT NULL DEFAULT false;

ALTER TABLE public.chats
  ADD COLUMN IF NOT EXISTS last_message_at timestamptz;

-- ── chat_members: passively-built member roster ─────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  telegram_user_id bigint NOT NULL,
  username text,
  display_name text,
  role_tag text NOT NULL DEFAULT 'member', -- eb | member | new
  coins int NOT NULL DEFAULT 0,
  streak_days int NOT NULL DEFAULT 0,
  last_streak_date date,
  shipping_opt_in boolean NOT NULL DEFAULT true,
  message_count int NOT NULL DEFAULT 0,
  caps_strikes int NOT NULL DEFAULT 0,
  last_caps_at timestamptz,
  last_active_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_id, telegram_user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_members TO authenticated;
GRANT ALL ON public.chat_members TO service_role;
ALTER TABLE public.chat_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage chat_members" ON public.chat_members FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE INDEX IF NOT EXISTS chat_members_chat_idx ON public.chat_members(chat_id, coins DESC);

-- ── economy_ledger ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.economy_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  telegram_user_id bigint NOT NULL,
  delta int NOT NULL,
  reason text NOT NULL, -- game_win | daily_bonus | vibe_gift | streak | shop_purchase | admin_adjust | tumba_send
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.economy_ledger TO authenticated;
GRANT ALL ON public.economy_ledger TO service_role;
ALTER TABLE public.economy_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read economy_ledger" ON public.economy_ledger FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
CREATE INDEX IF NOT EXISTS economy_ledger_chat_idx ON public.economy_ledger(chat_id, created_at DESC);

-- ── shop_items ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shop_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid REFERENCES public.chats(id) ON DELETE CASCADE, -- null = global default item
  key text NOT NULL,
  title text NOT NULL,
  description text,
  price int NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shop_items TO authenticated;
GRANT ALL ON public.shop_items TO service_role;
ALTER TABLE public.shop_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage shop_items" ON public.shop_items FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.shop_items (chat_id, key, title, description, price) VALUES
  (NULL, 'roast', 'Роаст на заказ', 'Бот жёстко (но по-доброму) роастит выбранного мембера', 50),
  (NULL, 'mafia_immunity', 'Иммунитет от роли предателя', 'Разовая привилегия в следующей игре Мафия', 60),
  (NULL, 'coin_gift', 'Подарить коины другу', 'Перевести часть своих БешКоинов другому мемберу', 20),
  (NULL, 'tumba_boost', 'Буст сахарка', 'Твой сахарок в Тумбе запостят вне очереди с рамкой', 30),
  (NULL, 'custom_title', 'Кастомный титул на неделю', 'Бот будет звать тебя выбранным титулом всю неделю', 40)
ON CONFLICT DO NOTHING;

-- ── chat_features: per-chat feature toggles ────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_id, feature_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_features TO authenticated;
GRANT ALL ON public.chat_features TO service_role;
ALTER TABLE public.chat_features ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage chat_features" ON public.chat_features FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER chat_features_updated_at BEFORE UPDATE ON public.chat_features
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ── game_sessions: generic state machine for all mini-games ────────────
CREATE TABLE IF NOT EXISTS public.game_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  type text NOT NULL, -- mafia | crocodile | taboo | truth_or_dare | cringe | aiesec_quiz | two_truths | meme_of_day | totalizator | who_said_this | archetype_quiz
  short_code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'waiting', -- waiting | active | finished | cancelled
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.game_sessions TO authenticated;
GRANT ALL ON public.game_sessions TO service_role;
ALTER TABLE public.game_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read game_sessions" ON public.game_sessions FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
CREATE INDEX IF NOT EXISTS game_sessions_chat_status_idx ON public.game_sessions(chat_id, status);
CREATE TRIGGER game_sessions_updated_at BEFORE UPDATE ON public.game_sessions
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- ── bot_dialogs: multi-step private (DM) conversation state ─────────────
CREATE TABLE IF NOT EXISTS public.bot_dialogs (
  telegram_user_id bigint PRIMARY KEY,
  kind text NOT NULL, -- tumba_compose | mafia_role_pending | two_truths_submit | ama_submit
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.bot_dialogs TO service_role;
ALTER TABLE public.bot_dialogs ENABLE ROW LEVEL SECURITY;
-- No authenticated policies: this is bot-internal scratch state only.

-- ── tumba_messages ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tumba_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  from_telegram_user_id bigint NOT NULL,
  to_username text,
  category text NOT NULL DEFAULT 'compliment', -- confession | compliment | question | ship
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending', -- pending | approved | blocked | posted
  moderation_reason text,
  telegram_message_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz
);
GRANT SELECT, INSERT, UPDATE ON public.tumba_messages TO authenticated;
GRANT ALL ON public.tumba_messages TO service_role;
ALTER TABLE public.tumba_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage tumba_messages" ON public.tumba_messages FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE INDEX IF NOT EXISTS tumba_messages_chat_status_idx ON public.tumba_messages(chat_id, status);

-- ── shipping_matches ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shipping_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  user_a bigint NOT NULL,
  user_b bigint NOT NULL,
  stage int NOT NULL DEFAULT 0, -- 0 = hint1 sent, 1 = hint2 sent, 2 = revealed
  status text NOT NULL DEFAULT 'active', -- active | revealed | expired
  next_step_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.shipping_matches TO authenticated;
GRANT ALL ON public.shipping_matches TO service_role;
ALTER TABLE public.shipping_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read shipping_matches" ON public.shipping_matches FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ── cringe_entries: quote bank for "Кто этот Кринж" ─────────────────────
CREATE TABLE IF NOT EXISTS public.cringe_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  quote_text text NOT NULL,
  telegram_user_id bigint NOT NULL, -- subject of the quote
  source_message_id bigint,
  added_by_user_id bigint,
  is_active boolean NOT NULL DEFAULT true,
  is_used boolean NOT NULL DEFAULT false,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.cringe_entries TO authenticated;
GRANT ALL ON public.cringe_entries TO service_role;
ALTER TABLE public.cringe_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage cringe_entries" ON public.cringe_entries FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ── quiz_questions: AIESEC quiz + archetype test bank ───────────────────
CREATE TABLE IF NOT EXISTS public.quiz_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid REFERENCES public.chats(id) ON DELETE CASCADE, -- null = global bank
  category text NOT NULL DEFAULT 'aiesec', -- aiesec | archetype
  language text NOT NULL DEFAULT 'ru',
  question text NOT NULL,
  options jsonb NOT NULL, -- string[]
  correct_option int, -- null for archetype (scored by tally, not right/wrong)
  meta jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quiz_questions TO authenticated;
GRANT ALL ON public.quiz_questions TO service_role;
ALTER TABLE public.quiz_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage quiz_questions" ON public.quiz_questions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.quiz_questions (category, language, question, options, correct_option) VALUES
  ('aiesec', 'ru', 'Что означает аббревиатура LCP?', '["Local Committee President", "Local Committee Partner", "Leadership Career Path", "Local Conference Program"]'::jsonb, 0),
  ('aiesec', 'ru', 'Что такое Roll Call?', '["Перекличка на паре", "Традиционная кричалка делегации на конференции", "Отчёт по KPI", "Список должников по взносам"]'::jsonb, 1),
  ('aiesec', 'ru', 'oGV расшифровывается как...', '["outgoing Global Volunteer", "official Global Vote", "outbound Group Visit", "organizational Global Value"]'::jsonb, 0),
  ('aiesec', 'ru', 'Кто такой Buddy в AIESEC?', '["Фасилитатор тренинга", "Куратор для приезжающего иностранного участника обмена", "Технический саппорт", "Второй LCP"]'::jsonb, 1),
  ('aiesec', 'ru', 'LCM — это...', '["Local Committee Meeting", "Leadership Council Motion", "Local Career Match", "Long Conference Module"]'::jsonb, 0)
ON CONFLICT DO NOTHING;

INSERT INTO public.quiz_questions (category, language, question, options, correct_option, meta) VALUES
  ('archetype', 'ru', 'На LCM ты обычно...', '["Веду собрание и раздаю задачи", "Кричу громче всех на Roll Call", "Кидаю мемы в чат весь созвон", "Тихо делаю заметки и всё выполняю"]'::jsonb, NULL, '{"tags":["лидер","хайп","мемолог","трудяга"]}'::jsonb),
  ('archetype', 'ru', 'Дедлайн через час, а работы непочатый край. Твои действия?', '["Организую всех и распределяю остаток задач", "Устраиваю мотивационную речь под музыку", "Шучу про это в чате, чтобы не паниковать", "Молча сажусь и доделываю всё сам(а)"]'::jsonb, NULL, '{"tags":["лидер","хайп","мемолог","трудяга"]}'::jsonb),
  ('archetype', 'ru', 'Что для тебя AIESEC в первую очередь?', '["Платформа для роста и управления людьми", "Движ, движ и ещё раз движ", "Комьюнити приколов и внутренних мемов", "Возможность прокачать хард-скиллы"]'::jsonb, NULL, '{"tags":["лидер","хайп","мемолог","трудяга"]}'::jsonb),
  ('archetype', 'ru', 'На конфе ты...', '["Модерирую панель или веду сессию", "В первых рядах на танцах и роллколе", "Собираю материал для мемов о конфе", "Записываю инсайты в блокнот"]'::jsonb, NULL, '{"tags":["лидер","хайп","мемолог","трудяга"]}'::jsonb),
  ('archetype', 'ru', 'Твоя суперсила в команде?', '["Вижу картину целиком и веду к цели", "Заряжаю энергией даже мёртвый чат", "Превращаю провал в смешную историю", "Довожу любое дело до конца без напоминаний"]'::jsonb, NULL, '{"tags":["лидер","хайп","мемолог","трудяга"]}'::jsonb)
ON CONFLICT DO NOTHING;

-- ── stickers: category -> file_id map ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stickers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL, -- радость | кринж | обида | угар | победа
  sticker_set_name text,
  file_id text NOT NULL,
  telegram_sticker_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stickers TO authenticated;
GRANT ALL ON public.stickers TO service_role;
ALTER TABLE public.stickers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage stickers" ON public.stickers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
