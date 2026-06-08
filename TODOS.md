# TODOs

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
