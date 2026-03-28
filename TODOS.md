# TODOs

## Deferred Items

- **Response caching for LLM calls** (P2, Medium effort)
  - 24h TTL, keyed by HTML content hash
  - Avoids redundant LLM calls for the same page content

- **Strip unused scoring math from compute-score.ts** (P3, Small effort)
  - Remove `ScoreBreakdown`, `computeCoverage()`, `computeQuality()`, `computeCompleteness()` and helpers (~150 lines)
  - UI no longer renders numeric scores or breakdown bars (removed in PR #1)
  - Only `schemasFixed`, `schemasAdded`, `issuesResolved`, `summary` are consumed by `ScoreHero`
  - `page-expectations.ts` weighted expectations would also become dead code
  - Code is recoverable from git history if scoring UI returns
