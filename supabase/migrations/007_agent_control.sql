-- Agent run control channel (agent Phase 4).
-- A cross-request signal the control surface (POST /api/agent/run/[id]) writes and
-- the long-lived run loop (runGoal) polls at each checkpoint. The streaming request
-- and the kill request are separate HTTP requests, so the signal must live in the DB
-- (an in-memory registry would not survive a multi-instance / serverless deploy).
--
-- Only 'run' and 'kill' are wired in Phase 4. 'pause' is reserved in the CHECK for the
-- Phase 5 durable pause/resume work so that lands without another migration.
ALTER TABLE public.agent_runs
  ADD COLUMN control TEXT NOT NULL DEFAULT 'run'
    CHECK (control IN ('run', 'pause', 'kill'));

-- agent_runs.status CHECK (queued|running|paused|done|failed) from migration 006 is
-- unchanged: a kill still finalizes the run as 'failed' (see runGoal). RLS stays on with
-- no policies — control is read/written exclusively by the service-role client.
