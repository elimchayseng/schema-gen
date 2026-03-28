# TODOs

## Deferred Items

- **Fix All cost estimate + concurrency control** (P1, Medium effort)
  - Show estimated LLM cost before user clicks Fix All (e.g., "~$1.80 for 12 pages")
  - Process pages 3-5 at a time, not all at once
  - Add per-page timeout (15s) to prevent one slow page from blocking the batch
  - Context: raised during eng review outside voice challenge (2026-03-27)

- **Sitemap quality filtering + fallback** (P1, Medium effort)
  - Filter admin/duplicate URLs from Shopify auto-generated sitemaps
  - Common Shopify sitemap issues: admin paths, paginated variants, duplicate URLs
  - Consider link-following crawler as v2 fallback for stores with no sitemap
  - Context: outside voice flagged that many small Shopify stores have poor sitemaps

- **Response caching for LLM calls** (P1, Medium effort — upgraded from P2)
  - 24h TTL, keyed by HTML content hash
  - Avoids redundant LLM calls for the same page content
  - Especially valuable for site-wide crawl: Shopify stores with 50 product pages using the same template would save ~50% of LLM calls (~$3.75 per crawl)
  - Context: upgraded from P2 after site-wide crawl feature makes this much more impactful

- **Strip unused scoring math from compute-score.ts** (P3, Small effort)
  - Remove `ScoreBreakdown`, `computeCoverage()`, `computeQuality()`, `computeCompleteness()` and helpers (~150 lines)
  - UI no longer renders numeric scores or breakdown bars (removed in PR #1)
  - Only `schemasFixed`, `schemasAdded`, `issuesResolved`, `summary` are consumed by `ScoreHero`
  - `page-expectations.ts` weighted expectations would also become dead code
  - Code is recoverable from git history if scoring UI returns
