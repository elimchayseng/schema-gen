-- Agent run audit trail (agent Phase 2).
-- One row per goal execution (agent_runs) and one append-only row per action
-- the agent takes on a page (agent_actions). Server-only (service-role writes).

CREATE TABLE public.agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID REFERENCES public.sites(id) ON DELETE CASCADE,
  goal JSONB NOT NULL,                       -- snapshot of the Goal that drove the run
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'paused', 'done', 'failed')),
  iterations INTEGER NOT NULL DEFAULT 0,
  pages_touched INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX idx_agent_runs_site ON public.agent_runs(site_id);

CREATE TABLE public.agent_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('generate', 'fix', 'write', 'verify', 'rollback', 'skip')),
  schema_before JSONB,
  schema_after JSONB,
  gates JSONB,                               -- {L0,L1,L2,L3} gate results
  write_target TEXT,                         -- staging theme id / asset key (null in dry-run)
  outcome TEXT NOT NULL,
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_actions_run ON public.agent_actions(run_id);

-- Backfill the FK that 005 deferred: theme_backups.run_id -> agent_runs.id.
-- (All existing theme_backups.run_id values are NULL, so this is safe.)
ALTER TABLE public.theme_backups
  ADD CONSTRAINT theme_backups_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES public.agent_runs(id) ON DELETE SET NULL;

-- Server-only: written exclusively by the agent via the service-role client.
-- RLS on with no policies => anon/authenticated roles get zero access.
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_actions ENABLE ROW LEVEL SECURITY;
