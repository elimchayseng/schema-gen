-- The latest named step checkpoint a run passed (uniform step contract).
-- Written best-effort by recordStep() on every stepEvent, so a reconnecting
-- client — or GET /api/agent/run/[id] — can show exactly where a run is (or
-- where it was when it stalled) without the SSE stream.
-- Shape: { phase, step, status, url, detail, durationMs, at }.
-- NULL for runs predating this migration.

ALTER TABLE public.agent_runs
  ADD COLUMN last_step JSONB;
