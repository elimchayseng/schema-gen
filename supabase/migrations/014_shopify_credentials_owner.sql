-- Multi-tenancy + secret-at-rest hardening for shopify_credentials (issue #32).
--
-- Two gaps from the 2026-06-12 pre-landing review:
--   1. The table was keyed globally by shop_domain with no owner column, so two
--      authenticated users provisioning the same myshopify domain shared one row
--      and user B could silently overwrite user A's app_secret (confused deputy).
--   2. app_secret / storefront_password were plaintext TEXT.
--
-- This migration adds the ownership column. Secret encryption is done at the
-- application layer (src/lib/crypto/secrets.ts, AES-256-GCM keyed by
-- CREDENTIAL_ENCRYPTION_KEY) so a DB-level read (backup leak, dashboard view,
-- service-role-key compromise) yields ciphertext, not usable secrets. No DB
-- extension is required and the secret key never enters a SQL statement.
--
-- owner_id is NULLABLE so existing single-tenant rows keep working: the first
-- authenticated upsert that touches a null-owner row CLAIMS it (sets owner_id),
-- and from then on a different owner is refused at the application layer.

ALTER TABLE public.shopify_credentials
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.shopify_credentials.owner_id IS
  'auth.users id that provisioned this shop. NULL = legacy/unclaimed. The app '
  'layer (upsertShopCredentials) refuses to overwrite a row owned by a different '
  'user; identity is effectively (owner_id, shop_domain).';

-- Lookups by owner for future per-owner listing / dashboards.
CREATE INDEX IF NOT EXISTS shopify_credentials_owner_id_idx
  ON public.shopify_credentials (owner_id);

COMMENT ON COLUMN public.shopify_credentials.app_secret IS
  'AES-256-GCM ciphertext (v1:iv:tag:ct) when CREDENTIAL_ENCRYPTION_KEY is set; '
  'legacy/dev rows may be bare plaintext (read path tolerates both).';
COMMENT ON COLUMN public.shopify_credentials.storefront_password IS
  'AES-256-GCM ciphertext (v1:iv:tag:ct) when CREDENTIAL_ENCRYPTION_KEY is set; '
  'nullable; legacy/dev rows may be bare plaintext.';
