-- Per-site Shopify credentials (issue #25, garnerandtow POC).
-- One row per shop. Replaces the single global SHOPIFY_SHOP / SHOPIFY_APP_KEY /
-- SHOPIFY_APP_SECRET env triple so the agent can run against more than one
-- store (the dev store stays on env via the fallback in
-- src/lib/shopify/credentials.ts).

CREATE TABLE public.shopify_credentials (
  -- Normalized myshopify host, e.g. 'garnerandtow.myshopify.com'. The CHECK
  -- mirrors normalizeShop() so a raw/un-normalized domain can't slip in and
  -- create a second row for the same shop.
  shop_domain TEXT PRIMARY KEY
    CHECK (shop_domain = lower(shop_domain) AND shop_domain LIKE '%.myshopify.com'),
  app_key TEXT NOT NULL,             -- client_credentials app client_id
  app_secret TEXT NOT NULL,          -- client secret; service-role access only
  storefront_password TEXT,          -- nullable; unlocks password-gated storefronts for L4 verify
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Secrets table: RLS enabled with NO policies, so anon/authenticated roles get
-- zero access. Reads and writes happen exclusively through the service-role
-- client (createAdminClient bypasses RLS) — same pattern as theme_backups (005)
-- and agent_runs.control (007).
ALTER TABLE public.shopify_credentials ENABLE ROW LEVEL SECURITY;
-- Map a site's public domain to its Shopify admin domain (issue #25).
-- sites.domain holds what the crawler sees (e.g. 'garnerandtow.com');
-- shop_domain holds the normalized myshopify host the Admin API needs
-- (e.g. 'garnerandtow.myshopify.com') and joins to shopify_credentials.
-- Nullable: non-Shopify sites (and rows created before this migration)
-- simply have no admin mapping.

ALTER TABLE public.sites
  ADD COLUMN shop_domain TEXT
    CHECK (shop_domain IS NULL
           OR (shop_domain = lower(shop_domain) AND shop_domain LIKE '%.myshopify.com'));
-- The concrete URL list a run resolved its goal scope to (issue #27).
-- Written best-effort right after resolveTargetUrls, so the merchant report can
-- compute notReached exactly for ANY scope (site / all_products / all_pages),
-- not just url_list goals whose URLs already live inside the goal snapshot.
-- JSONB array of strings; NULL for runs predating this migration (the report
-- falls back to goal.target.urls for url_list goals, as before).

ALTER TABLE public.agent_runs
  ADD COLUMN resolved_urls JSONB;
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
-- Authoritative override mode (issues #23/#24) + staging publish (#26 wiring).
-- Three new append-only action kinds in the audit trail:
--   suppress        — a competing theme JSON-LD emission was reversibly silenced
--                     on the write-target theme (suppress.ts markers)
--   merchant_action — structured "the merchant must do X" record (e.g. an app
--                     injects schema we cannot remove via theme edits)
--   publish         — the staging theme was published (atomic swap); outcome
--                     carries the rollback artifact (the previous live theme id)

ALTER TABLE public.agent_actions
  DROP CONSTRAINT agent_actions_action_check;

ALTER TABLE public.agent_actions
  ADD CONSTRAINT agent_actions_action_check
  CHECK (action IN (
    'generate', 'fix', 'write', 'verify', 'rollback', 'skip',
    'suppress', 'merchant_action', 'publish'
  ));
