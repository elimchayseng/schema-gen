# QA: Garnerandtow POC — full e2e workflow

**Status (2026-06-11):** the pipeline is feature-complete and proven on the dev store.
This doc is the QA pass you run before pointing it at garnerandtow.com.

The workflow under test:

```
provision (landing page, one-time credential connect)
  → dry run (perceive → plan → generate → gate L0–L3, nothing written)
  → live apply (staging theme → write footprint + suppress competing emitters
                → L4 preview-verify + duplicate gate, auto-rollback on failure)
  → publish (atomic swap; displaced theme kept as the rollback artifact)
  → post-publish verify (NEW: re-checks the REAL published URLs;
                         auto-republishes the displaced theme on a definite failure)
  → merchant report with Google Rich Results Test links
```

What's new since the last QA pass (commits `97416184`, `dc875d97`):

1. **Post-publish verification** (`src/lib/agent/post-publish.ts`). L4 verified the
   *preview* render; this verifies what shoppers and Google actually get. It uses the
   freshness proof (this run's staged JSON-LD must appear in the render, by value) to
   tell a stale cache copy (re-poll, never fail) from a genuinely wrong published
   render (definite failure → the displaced theme is republished automatically).
2. **Persistent staging theme.** A run reuses an existing unpublished
   `SchemaGen Staging …` theme and syncs only checksum-changed assets — seconds
   instead of the ~10-minute full duplicate. First run on a store (or after a
   publish consumed the staging theme) still does one full duplicate.

---

## 1. Setup (once)

1. `npm install && npm run verify` — expect 684 tests green.
2. `.env.local` must contain (it already does on this machine):
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `HEROKU_INFERENCE_URL` / `_KEY` / `_MODEL` (schema generation)
   - `SHOPIFY_SHOP`, `SHOPIFY_APP_KEY`, `SHOPIFY_APP_SECRET` (dev-store fallback creds)
   - `SHOPIFY_STOREFRONT_PASSWORD` (the dev store is password-gated)
   - `SHOPIFY_TEST_THEME_ID` (for env-mode writes)
3. `npm run dev` → http://localhost:3000, and **log in** (Supabase email/password —
   all agent routes 401/redirect without a session).
4. Scripts note: `tsx` does **not** auto-load `.env.local`. Always run scripts as
   `npx tsx --env-file=.env.local scripts/<name>.ts` (a silent missing password makes
   every live fetch see the password wall and report 0 JSON-LD blocks).

Dev store: `ethan-dev-store-1.myshopify.com`. Currently published theme is
`SchemaGen Staging 2026-06-11` (185610797101) — the verified result of the last live
apply. `Horizon` (185475498029) is the displaced original, kept as rollback.

## 2. QA flow A — the UI e2e (the merchant's experience)

1. **Provision:** on `/`, enter the dev store URL. Expand the credential connect and
   enter the myshopify domain, app key/secret, and storefront password → "Optimize my
   store". Expect redirect to `/agent/<siteId>`. (Creds land in the `shopify_credentials`
   table; the `sites` row gets `shop_domain`, which unlocks the staging write modes.)
2. **Dry run:** open Advanced settings → scope "Specific URLs", paste 2–3 product URLs,
   required types `Product, BreadcrumbList` → "Preview changes". Expect live progress
   rows with gate chips (L0–L3), then a verdict banner and per-page before/after JSON.
   Nothing is written.
3. **Tweak panel (sticky merchant correction):** expand a page row → "Refine with AI",
   type a natural-language correction (e.g. "the brand is Acme, not the store name").
   Re-run the preview and confirm the correction **survives regeneration**.
4. **Live apply + publish:** select write mode "Staging + auto-publish when verified"
   → "Apply to my store". Watch for, in order:
   - `stage`: "staging theme … ready" — **first run says a few minutes (full
     duplicate); any later run should say "(reused — synced changed assets only)"
     and take seconds.** This is a headline QA check.
   - `apply`: per-page L4 chips go green (preview render verified, duplicates gone).
   - `publish`: "publishing staging theme …", then "verifying the published
     storefront…", then **"post-publish verification: verified"** (may take a few
     minutes — it is polling the real URLs through Shopify's page cache; "stale" is
     possible, see §4).
5. **Result card:** published-live note with the rollback theme id, summary stats,
   Google Rich Results Test links for fixed pages. Follow one link — Google must see
   exactly one Product (plus Shopify's own injected Organization, which is expected
   and platform-owned).
6. **Report:** "View the full report" → verdict banner, summary cards, per-page gate
   dots, before/after JSON, required-actions list.

## 3. QA flow B — script spot-checks (fast, no UI)

All from repo root, all prefixed with `npx tsx --env-file=.env.local`:

| Script | What it proves |
|---|---|
| `scripts/verify-live-final.ts` | The 3 dev-store product pages each render exactly 1 valid Product + 1 BreadcrumbList on the **published** storefront. Exit 0 = pass. |
| `scripts/preview-vs-published.ts` | Preview render of the published theme ≡ published render (the experiment that killed the "preview is structurally blind" theory). |
| `scripts/dev-live-e2e.ts run\|publish` | Full library-level live run against the dev store, no UI. |
| `scripts/publish-and-cleanup.ts` | Manual publish of a verified staging theme id + cleanup of superseded attempts. |

## 4. The cache gotcha (read before filing a bug)

Shopify's storefront page cache on a password-gated dev store can keep serving the
**pre-publish render for hours**, converging page by page, and its responses carry
fresh-looking headers. We proved (2026-06-11) the published theme renders correctly —
stale copies are a serving artifact, not a rendering bug.

So, when a page "still shows the old schema":

- Don't trust a bare-URL browser view. Append a throwaway query param
  (`?check=123`) or run `scripts/verify-live-final.ts` a few times.
- A **`post-publish verification: stale`** verdict means exactly this: the publish
  stands, the cache hadn't converged within the poll budget (~5 min). Re-run
  `verify-live-final.ts` later; it converges on its own.
- A **`failed`** verdict is the real thing: the staged blocks appeared and were
  wrong (e.g. a duplicate survived). The agent has already republished the displaced
  theme; the failing staging theme is kept unpublished as evidence. Run status will
  be `rolled_back` (or `paged` if even the republish failed — see §5).

## 5. Rollback procedures

- **Automatic:** L4 failure → byte-identical asset restore (nothing published).
  Post-publish failure → displaced theme republished automatically.
- **Manual undo of any publish:** Shopify admin → Online Store → Themes → find the
  previous theme (the run result and the publish audit row name its id:
  `published:<staging> displaced:<source>`) → ⋯ → Publish. The dev store's safety
  pair today: published `185610797101`, rollback `Horizon 185475498029`.
- **`paged` run status:** a rollback itself failed; the theme to republish by hand is
  named in the run error and the `post_publish_rollback_failed:` /
  `rollback_failed` audit rows. This is the only state needing a human.

## 6. Acceptance checklist for the garnerandtow one-shot

When real-store credentials are provisioned, the run should be a single trustworthy
shot. Tick these in order:

- [ ] `npm run verify` green at the commit being QA'd.
- [ ] Flow A passes end-to-end on the dev store, including a **reused** staging theme
      (run a live apply twice; the second must stage in seconds).
- [ ] `post-publish verification: verified` observed at least once on the dev store.
- [ ] Auto-rollback path exercised once (easiest: temporarily set required type to
      something the theme also emits and the plan doesn't suppress — or trust the
      unit suite: `run.staging.test.ts` covers failed/stale/crash branches).
- [ ] Dry run on garnerandtow.com still 30/30 green (`scripts/garner-dryrun.ts`).
- [ ] Provision garnerandtow with real creds → staging-only run (write mode
      "Staging preview", no publish) → eyeball the preview URL.
- [ ] Publish run → post-publish verified → open the Google Rich Results Test links
      from the report and confirm Google sees what the report claims.

## 7. Known limitations (POC-accepted)

- Post-publish "stale" doesn't block or retry beyond its budget; it reports and
  trusts later convergence. The report's Google links are the merchant's
  independent confirmation.
- The post-publish verdict surfaces in the progress stream message and run status;
  the result card doesn't yet render `staging.postPublish` per-page details (DB
  audit rows `post_publish:*` have it all).
- Shopify's platform-injected Organization JSON-LD (escaped-slash serialization)
  renders on every product page, preview and published alike. It is platform-owned,
  not removable via theme, and intentionally outside the duplicate gate (we gate
  the *required* types only).
