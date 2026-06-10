# Agent Live E2E Bring-Up — Branch Report

**Branch:** `feat/agent-real-e2e`
**Status:** Live end-to-end working against the real dev store `ethan-dev-store-1.myshopify.com`.
**Latest fix commit:** `1385eb35` — *fix(agent): make live e2e actually work end-to-end on a password-gated dev store*
**Verify:** `npm run verify` green — 382 passed, 3 integration tests skipped (gated behind `RUN_SHOPIFY_INTEGRATION`).

---

## 1. The original goal

Turn the half-working goal-based agent into something real:

> Take a site URL as the only input, show progress, and return when `theme.liquid` has fully injected and fully verified Google rich-results schema. Dead-simple one-click UX for a non-technical merchant. Schemas must be valid and the before/after demonstrable. The agent currently **crashes after the first validation failure** — it should use the LLM to self-correct and bring every page to valid, rich-eligible structured data.

Example failure that kicked it off: `https://pioneercarry.com/products/molecule-cardholder` —
`Event: Unknown schema type`, `Product: 'sku' is not valid on Offer`, `availability` wrong protocol.

## 2. Where the branch started (prior sessions)

By the time this session began, prior work had already landed:

- **Self-correcting repair loop** (`src/lib/agent/repair.ts`, wired into `executor.ts`): sanitize
  third-party junk types, re-run the deterministic fixer, feed exact validation errors back to the
  LLM, re-gate, loop until gates pass or attempts spent. The LLM is never a gate — every output is
  re-validated by `lib/validation`.
- **One-click UI** (`AgentRunner.tsx`): Preview (dry run) → Apply → Rich Results proof links.
- **Phase 4 control surface**: `POST /api/agent/run` (SSE) + `GET /api/agent/run/[id]`, and the
  dashboard page `src/app/site/[id]/agent/page.tsx`.
- A **password-wall diagnosis**: the previous session identified that dev stores 302-redirect the
  storefront to `/password` and shipped `src/lib/shopify/storefront-password.ts` to fetch a cookie
  for L4, plus an actionable error instead of a silent rollback.

The previous session reported the password fix as "verified against your real store." **It was not
actually working** (see Issue 1) — that only surfaced once we drove a real live run this session.

## 3. What we set out to do this session

The user had set `SHOPIFY_STOREFRONT_PASSWORD` in `.env.local` and authorized writing to the `main`
theme. The plan: drive a clean live apply via a script (not the UI) and prove the loop end-to-end.

The architecture constraint that shaped everything: the agent needs **one store it can read
(perceive), write (`theme.liquid`), and verify (L4)**. L4 verifies by re-fetching the goal's
storefront URL with `?preview_theme_id=<themeId>`, so perceive + write + verify must all target the
same store. The `sites` table only had external customer domains (`pioneercarry.com`,
`garnerandtow.com`) that we cannot write to; the real write target is the configured Shopify store
(`ethan-dev-store-1`) via env. So the run had to target the dev store's own products, and a `sites`
row for the dev store had to exist for the audit foreign key.

## 4. The issues, in the order they surfaced

### Issue 0 — No store one could read + write + verify together
- **Symptom:** `sites` rows were external stores; the dev store had no `sites` row and its storefront
  was password-gated (`/` and `/collections/all` → 302 → `/password`, `/sitemap.xml` → 404).
- **Resolution:** create a `sites` row for `ethan-dev-store-1.myshopify.com`, and target products via
  `url_list` scope with explicit product URLs (the sitemap is 404 while the store is password-gated,
  so `all_products` scope cannot enumerate them).

### Issue 1 — The storefront cookie was never actually obtained
- **Symptom:** first live run logged `Storefront password submitted but no storefront_digest cookie
  returned (status 302)`, and the AI client logs showed it generating schema from
  `url: .../password` (the password page, `rawHtmlLength: 11489`). The password itself was correct —
  a direct `POST /password` returned `302 → /` (success).
- **Root cause:** Shopify's storefront password flow **no longer sets `storefront_digest`**. Current
  dev stores set **`_shopify_essential`**. `getStorefrontCookie` looked only for `storefront_digest`,
  found none, returned null, and silently fell back to anonymous fetches. This is why the prior
  session's "verified" L4 fix had never truly run through the wall.
- **Proof:** captured the password-POST `Set-Cookie` jar (`_shopify_essential`, `by`), replayed it on
  a product page → `200` with valid Product JSON-LD; without it → `302 → /password`.
- **Fix:** `src/lib/shopify/storefront-password.ts` now builds the full cookie jar from every
  `Set-Cookie` first segment (dropping empty/deletion cookies) and treats the presence of
  **either** `_shopify_essential` or `storefront_digest` as success. Browser-style: echo the whole
  jar back on subsequent fetches.

### Issue 2 — Perceive could not read through the wall (only L4 could)
- **Symptom:** even after the cookie worked, perceive still saw the password page, because the cookie
  was only wired into L4 verify.
- **Root cause:** `processPage` (used by perceive's `scan` and the executor's `optimize`) called
  `fetchPage(url)` with no headers. `fetchPage` already supported a `Cookie` header; nothing passed
  one.
- **Fix:** thread an optional `fetchHeaders` through `processPage` → `executeTask`. In
  `src/lib/agent/run.ts`, fetch the storefront cookie **once** and attach it **only to fetches whose
  host matches the configured shop** (`normalizeShop` comparison), so public sites in a goal are
  still fetched anonymously. After this, perceive read the real product pages.

### Issue 3 — The LLM key was invalid (user-side, not code)
- **Symptom:** every page failed with `AI generation failed: LLM API returned 401: Invalid API key`,
  tripping the consecutive-failure breaker.
- **Root cause:** `HEROKU_INFERENCE_KEY` in `.env.local` was expired/revoked (confirmed with a direct
  `POST https://us.inference.heroku.com/v1/chat/completions` → 401).
- **Resolution:** user refreshed the key; a re-probe returned 200. (Operational note: this key
  rotates — probe it directly when the agent's generate/repair step fails wholesale.)

### Issue 4 — L4 rejected SchemaGen's OWN output (the real blocker)
- **Symptom:** with cookie + perceive + LLM all working, the dry run was perfect (all 3 products
  `staged`, valid rich-eligible Product), but the **live apply rolled back every time** with
  `apply.l4: [{passed:false, detail:"no valid 'Product' schema in the live render"}]`.
- **What we ruled out, with evidence:**
  - *Snippet doesn't render?* No — a controlled install + fetch showed `marker=true` and a valid
    Product on the live page.
  - *Eventual-consistency / propagation lag?* No — even with a 40s gap simulating the LLM time, the
    immediate post-write fetch rendered fresh.
  - *Full-page / CDN caching?* No — `cf-cache-status: DYNAMIC` (served from origin, not cached).
  - *Product-specific template?* No — reproduced the difference independent of product.
- **Root cause:** the injected snippet emits a **single `<script>` containing a top-level JSON array**
  `[Organization, Product]` (verified in `result.stagedSnippet`). `extractJsonLd`
  (`src/lib/url-validator/extractor.ts`) expanded `@graph` wrappers but **not** a top-level array, so
  it returned the whole array as one `parsed` value. `verifyHtml` then ran `schemaTypesOf(array)`,
  found no `@type`, and concluded "no valid Product" — even though the Product was right there inside
  the array. L0–L3 passed because the executor gates the already-flattened `candidates`, not the
  rendered array. **SchemaGen's L4 could never validate SchemaGen's own injected output.** The
  extractor had no direct unit test, which is why this stayed invisible.
- **Fix:** `extractJsonLd` now flattens a top-level array the same way it expands `@graph` (and
  handles `@graph` nested inside array items). Added `src/lib/url-validator/__tests__/extractor.test.ts`.

### Issue 5 — `preview_theme_id` render reliability is theme-specific
- **Symptom:** after the extractor fix the agent's L4 passed all 3, but an independent re-fetch of the
  live storefront showed the marker on some products and not others — stable, not lag.
- **Finding:** this was specific to the **old `test-data` theme** (a Dawn-ish theme,
  `185475563565`) when written-to and previewed live. The modern **Horizon** theme (`185475498029`)
  renders consistently in both states — reliable as an unpublished preview and after publishing.
- **Resolution:** user set `SHOPIFY_TEST_THEME_ID=185475498029` and published Horizon. Final live run
  is green on the live storefront, stable across samples. Lesson: if L4 flakes, suspect the theme;
  prefer a current theme (Horizon / latest Dawn) as the write target.
  > Safety note still open: `resolveWriteThemeId()` does not check the theme **role**, so it will
  > write to a published `main` theme. That is now intentional here (Horizon is live), but a guard
  > (refuse `main` unless explicitly overridden) is still worth adding for the productized flow.

## 5. The full fix that made it work end-to-end

Four code changes (one commit, `1385eb35`), plus two environment/config actions by the user.

**Code (the durable fix):**
1. `storefront-password.ts` — capture the full session-cookie jar; accept `_shopify_essential`
   (current) or `storefront_digest` (legacy).
2. `process-page.ts` + `executor.ts` — optional `fetchHeaders` threaded to the page fetch.
3. `run.ts` — fetch the storefront cookie once; attach it host-matched to perceive + execute.
4. `extractor.ts` — flatten top-level JSON-LD arrays (so L4 can read the injected `[Org, Product]`),
   plus the first direct extractor test.

**Environment / config (user-side):**
- Refresh `HEROKU_INFERENCE_KEY` (the LLM generate/repair step depends on it).
- Use a modern theme as the write target (`SHOPIFY_TEST_THEME_ID=185475498029`, Horizon), published.
- Keep `SHOPIFY_STOREFRONT_PASSWORD` set (the cookie path authenticates through the wall) — or disable
  the storefront password.

## 6. Proven end-to-end result

Final live run against the published Horizon theme:

```
goal (url_list: 3 products) -> perceive (through the password wall)
  -> plan -> LLM self-correct (1 repair pass/product) -> apply
  -> L4 verify -> applied

apply.status: applied   writeTarget: 185475498029
L4: 3/3 passed ("live render carries valid Product")
```

Independent verification on the live storefront (plain URL, no preview param — what Google's Rich
Results Test fetches), stable across samples:

| Product | Schema live | Valid + rich-eligible |
|---|---|---|
| selling-plans-ski-wax | yes | yes |
| the-3p-fulfilled-snowboard | yes | yes |
| the-collection-snowboard-hydrogen | yes | yes |

## 7. Open items / recommendations

- **Add a published-theme write guard** to `resolveWriteThemeId()` (refuse `main` unless explicitly
  overridden) for the productized flow. Currently writes to whatever `SHOPIFY_TEST_THEME_ID` points
  at, regardless of role.
- **Real web search is still not wired** — the Heroku LLM endpoint has no web tool; repair relies on
  page/URL context. (Carried over from prior sessions.)
- **Sitemap discovery is blocked while a store is password-gated** (`/sitemap.xml` → 404). For gated
  stores the run must use `url_list` scope or enumerate products via the Admin API; `all_products`
  scope only works once the store is public.
- **`HEROKU_INFERENCE_KEY` rotates** — when the agent fails generation wholesale, probe the inference
  endpoint directly before assuming a code bug.
- **No PR yet** — fixes are committed on `feat/agent-real-e2e` only.
