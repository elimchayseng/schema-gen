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
