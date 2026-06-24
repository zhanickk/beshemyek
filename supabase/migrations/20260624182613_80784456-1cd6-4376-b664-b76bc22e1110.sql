ALTER TABLE public.prompts ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
ALTER TABLE public.bot_settings ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'auto';
CREATE INDEX IF NOT EXISTS idx_prompts_language ON public.prompts(language) WHERE is_active;