-- Merchant overrides (issue #29): sticky per-page+field corrections to
-- LLM-generated JSON-LD. One row per (site, url, schema_type, field_path);
-- a regenerate MERGES these on top of fresh LLM output, so a merchant's
-- correction ("the brand is X") survives every future agent re-run.
--
-- field_path is a dot path into the matching JSON-LD node, e.g.
-- "description", "brand.name", "offers.0.availability".

CREATE TABLE public.merchant_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  schema_type TEXT NOT NULL,                 -- @type of the JSON-LD node targeted
  field_path TEXT NOT NULL,                  -- dot path within that node
  value JSONB NOT NULL,                      -- the merchant's value (any JSON shape)
  source TEXT NOT NULL CHECK (source IN ('chat', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, url, schema_type, field_path)
);

CREATE INDEX idx_merchant_overrides_site_url
  ON public.merchant_overrides(site_id, url);

-- Server-only, matching agent_runs/agent_actions (006): written exclusively via
-- the service-role client. RLS on with no policies => anon/authenticated roles
-- get zero access; site ownership is enforced in the API layer (the routes
-- verify the site belongs to the authenticated user before touching this table).
ALTER TABLE public.merchant_overrides ENABLE ROW LEVEL SECURITY;
