# TODOs

## Security & Concurrency (from 2026-06-12 adversarial review)

- **Tenant-bind shopify_credentials — block cross-tenant clobbering** (P0, Medium effort)
  - `shopify_credentials` is keyed by `shop_domain` alone (migration 008) and
    `upsertShopCredentials` upserts `onConflict: "shop_domain"` with no ownership
    check (`src/lib/shopify/credentials.ts`, provision route). Any authenticated
    user can overwrite another tenant's app_key/app_secret/storefront_password by
    provisioning the same domain — breaks or hijacks their pipeline.
  - Fix: migration 014 adds a user/tenant column + unique(shop_domain, user) or an
    ownership check in the provision route before upsert; verify creds against
    Shopify before accepting. Also revisit the skipped migration-008 finding
    (plaintext secrets) in the same pass.
  - MUST land before signup opens beyond invited users. Accepted at /ship gate
    2026-06-12 because signup is currently closed.

- **Concurrency guard: atomic claim + heartbeat liveness** (P0, Medium effort)
  - The 409 guard in `src/app/api/agent/run/route.ts` is check-then-act: two
    simultaneous live POSTs both pass the SELECT before either inserts. Fix at the
    DB layer: partial unique index `agent_runs(site_id) WHERE status='running' AND
    goal->>'dryRun'='false'`, treat insert conflict as 409.
  - The 30-min stale cutoff disarms the guard during legitimately long live runs
    (prepareStagingTheme is minutes; l4Verify backoff adds up to 12s/page). Key
    liveness off a heartbeat (`last_step.at`, migration 013) instead of started_at.

- **Run-route hardening mediums (P1, batched)**
  - Chat endpoint: add size caps on `message`/`currentJsonld` + rate limit
    (`overrides/chat/route.ts`) — unbounded LLM cost/DB bloat.
  - Chat save loop: all-or-nothing override persistence (mid-loop failure persists
    half a correction set).
  - `credentials.ts`: for shops WITH a stored row, a transient Supabase error
    silently falls back to env creds for the wrong shop — should throw.
  - Orphaned `status:"running"` rows never reaped after process crash — sweeper or
    startup reap.
  - Staging theme leak when an exception bypasses the rolled_back cleanup path.
  - `url_list` scope accepts arbitrary external domains — constrain to site domain.
  - Rehydration page `select("*")` ships raw goal/control/error to the client —
    select only rendered columns.
  - Re-assert `assertSafeWriteTheme` before publish (role can flip mid-run).

## Deferred Items

- **Fix All cost estimate + concurrency control** (P1, Medium effort)
  - Show estimated LLM cost before user clicks Fix All (e.g., "~$1.80 for 12 pages")
  - Process pages 3-5 at a time, not all at once
  - Add per-page timeout (15s) to prevent one slow page from blocking the batch
  - Context: raised during eng review outside voice challenge (2026-03-27)
  - NOTE: the AGENT loop (`runGoal`) now batches perceive/act at a 1–5 concurrency cap
    (Phase 5, `concurrency.ts`). This item remains for the `fix-all` crawl ROUTE, which
    still fans out all pages at once and has no pre-flight cost estimate.

- **Sitemap link-following crawler fallback** (P2, Medium effort)
  - DONE in Phase 5: admin/duplicate/feed/pagination filtering + dedup now runs inside
    `fetchSitemap` (`filterSitemapUrls`), shared by the crawl and the agent.
  - Remaining: a link-following crawler as a v2 fallback for stores with no sitemap.
  - Context: outside voice flagged that many small Shopify stores have poor sitemaps.

- **Real LLM token cost accounting for the agent budget breaker** (P1, Medium effort)
  - Phase 3 ships the cost circuit-breaker MECHANISM (`breakers.ts` halts when
    `costUsd > maxCostUsd`) but production `costUsd` is hard-coded `0`, so the breaker
    never actually trips on a live run.
  - Thread real token usage out of `generateSchemas`/`refineAllRecommendations` →
    `processPage` → `executeTask` → `runGoal` so the running sum is accurate.
  - Until then `maxCostUsd` is enforced only against injected costs in unit tests.
  - Context: eng review decision D3 (2026-06-06), Phase 3. See docs/agent/phase-3-design.md.
  - Depends on: nothing; orthogonal to the guardrail work.

- **Strip unused scoring math from compute-score.ts** (P3, Small effort)
  - Remove `ScoreBreakdown`, `computeCoverage()`, `computeQuality()`, `computeCompleteness()` and helpers (~150 lines)
  - UI no longer renders numeric scores or breakdown bars (removed in PR #1)
  - Only `schemasFixed`, `schemasAdded`, `issuesResolved`, `summary` are consumed by `ScoreHero`
  - `page-expectations.ts` weighted expectations would also become dead code
  - Code is recoverable from git history if scoring UI returns
