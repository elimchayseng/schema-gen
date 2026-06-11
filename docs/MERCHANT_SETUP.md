# SchemaGen Merchant Setup — One-Shot Provisioning

This is the complete list of what a merchant does. Everything else — crawling,
validating, fixing, suppressing broken theme schema, injecting, verifying, and
proving — is the agent's job.

## What the merchant does (once, ~5 minutes)

### 1. Grant the agent access to the store

Create app credentials SchemaGen can use to read and write themes:

1. Go to the [Shopify Partners / dev dashboard](https://dev.shopify.com) (or
   have your agency do this step) and create an app for the store.
2. Grant the app these Admin API scopes — the minimum the agent needs:
   - `read_themes`, `write_themes` — inject and verify structured data in a
     **duplicate** of your live theme (the published theme is never edited
     directly; the agent refuses to write to it)
   - `read_products` — enumerate the catalog when the sitemap is unavailable
3. Install the app on the store and note the **API key** and **API secret**.
4. If the storefront is password-protected (Online Store → Preferences), note
   the storefront password too — the agent needs it to verify rendered pages.

### 2. Provide the homepage URL

Open SchemaGen, paste the store's homepage URL (e.g. `https://garnerandtow.com`)
plus the credentials from step 1, and click **Optimize my store**.

That's it. There is no step 3.

## What the agent does from there (no merchant action)

1. **Scan** — enumerates the whole site (homepage, products, collections,
   articles, pages) from the sitemap, falling back to the Shopify Admin API if
   the sitemap is gated or empty.
2. **Validate** — every existing JSON-LD block is parsed (including blocks so
   broken they don't parse — those are surfaced, never ignored) and judged
   against schema.org plus Google's current Rich Results requirements.
3. **Generate & repair** — missing or invalid schema is generated from the
   page's real content, run through deterministic gates, and self-corrected
   until it passes. The required set per page type:

   | Page | Schema injected |
   |---|---|
   | Homepage | Organization + WebSite |
   | Product | Product (offers/price/availability) + BreadcrumbList |
   | Collection | CollectionPage + BreadcrumbList |
   | Blog article | BlogPosting + BreadcrumbList |
   | Page | WebPage |

4. **Take ownership** — schema emitted by the theme itself (including broken
   blocks) is suppressed with reversible markers so exactly one valid block per
   type renders. Schema injected by third-party apps can't be removed via the
   theme — the report lists the exact app setting to disable, the only case
   where a merchant action can be required.
5. **Inject safely** — all changes are written to a duplicate of the live
   theme, verified on its rendered preview, and only published (atomic swap)
   when every page passes every gate. Any failure → automatic byte-identical
   rollback; the live store is never exposed to an unverified state.
6. **Prove it** — a "You're good to go" report: every page checked, what was
   already good / fixed / generated, before/after schema, and a per-page
   **Confirm with Google** link to the Google Rich Results Test. Verdicts are
   honestly labeled: "Validated by SchemaGen (deterministic gates)" vs
   "Confirmed by Google".

## Optional: review the AI-generated text

Any LLM-written value (product descriptions, brand copy) can be corrected
conversationally from the report — "the brand name is Garner & Tow, not
GarnerTow" — and the correction is **sticky**: it survives every future re-run.
This is optional; nothing requires merchant review.

## Operator notes (agency side)

- Apply Supabase migrations `008`–`012` before the first per-site run
  (`shopify_credentials`, `sites.shop_domain`, `agent_runs.resolved_urls`,
  `merchant_overrides`, authoritative action kinds). Convenience concat for the
  dashboard SQL editor: `docs/agent/pending-migrations-008-012.sql`. The agent
  degrades gracefully on unmigrated schemas (per-site context and exact
  not-reached accounting are disabled with warnings) but staging/override
  features need the migrations.
- Credentials are stored server-side (service-role only) via
  `POST /api/agent/provision` with `{url, shopDomain, appKey, appSecret,
  storefrontPassword?}` or `upsertShopCredentials()` directly. Tokens are
  minted on demand and never logged.
- Env-based single-store config (`SHOPIFY_SHOP` + `SHOPIFY_TEST_THEME_ID`)
  still works and is the default for the dev store; per-site credentials
  activate when `sites.shop_domain` is set.
- The agent never writes to a theme with role `main`. Staging mode duplicates
  the published theme (minutes on large themes — progress is streamed) and
  publishes only after all gates pass.
