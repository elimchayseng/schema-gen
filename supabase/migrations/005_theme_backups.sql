-- Rollback tokens for Shopify theme asset writes (agent Phase 0).
-- One row per asset snapshot taken before a write; restore re-PUTs
-- asset_value_before so the live theme returns to its exact prior state.

CREATE TABLE public.theme_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- FK to agent_runs is added in Phase 2 (that table does not exist yet);
  -- nullable so standalone Phase 0 backups (no run) are valid.
  run_id UUID,
  shop TEXT NOT NULL,
  theme_id BIGINT NOT NULL,            -- Shopify theme id (numeric)
  asset_key TEXT NOT NULL,             -- e.g. 'layout/theme.liquid'
  asset_value_before TEXT NOT NULL,    -- exact prior value, for byte-identical restore
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_theme_backups_run ON public.theme_backups(run_id);
CREATE INDEX idx_theme_backups_shop_theme ON public.theme_backups(shop, theme_id);

-- Server-only table: backups are written exclusively by the agent via the
-- service-role client (createAdminClient), which bypasses RLS. Enable RLS with
-- NO policies so the anon/authenticated roles get zero access (no token-adjacent
-- theme contents leak to end users).
ALTER TABLE public.theme_backups ENABLE ROW LEVEL SECURITY;
