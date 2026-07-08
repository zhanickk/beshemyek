-- Quote pool: shared (/cringe manual), who_said, cringe, auto (mined from chat)
ALTER TABLE public.cringe_entries
  ADD COLUMN IF NOT EXISTS pool text NOT NULL DEFAULT 'shared';

COMMENT ON COLUMN public.cringe_entries.pool IS 'shared | who_said | cringe | auto';

UPDATE public.cringe_entries SET pool = 'shared' WHERE pool IS NULL;
