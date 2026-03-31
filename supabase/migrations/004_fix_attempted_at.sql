-- Track fix-all attempts to prevent infinite re-processing
ALTER TABLE public.page_schemas ADD COLUMN fix_attempted_at TIMESTAMPTZ;
