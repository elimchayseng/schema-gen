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
