-- PENDING: paste into the Supabase SQL editor (same manual pattern as 008-012).
-- Adds agent_runs.last_step so a reconnecting client / GET /api/agent/run/[id]
-- can show exactly where a run is. recordStep() is best-effort: until this is
-- applied, runs work fine — the live step display just has nothing to read.

ALTER TABLE public.agent_runs
  ADD COLUMN last_step JSONB;
