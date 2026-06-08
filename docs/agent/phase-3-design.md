# Phase 3 Design — Guardrails + auto-apply (for eng review)

Source of truth: `AGENT_IMPLEMENTATION_PLAN.md` §7, `docs/agent/phase-3-guardrails.md`.
This doc is the proposed approach to lock before implementation. Focus areas for
review (per runbook): **rollback correctness** and **staging-theme correctness**.

## What Phase 2 already gives us

- `runGoal(goal, {dryRun})` — perceive → plan → act; currently throws on `dryRun:false`.
- Executor stages a `SnippetEntry` per gate-passing page; run renders ONE snippet
  from all entries (`renderSchemaGenSnippet`). Footprint = 1 snippet + 1 include
  line in `layout/theme.liquid`.
- Shopify primitives: `themeGet`, `listThemes`, `themeDuplicate(name, src)`,
  `assetGet/Upsert/Delete`, `themePublish`, `installSchemaGen/uninstallSchemaGen`,
  `backupAsset` / `restoreAsset` / `safeAssetUpsert` (snapshot + write-failure rollback),
  `theme_backups` table keyed by `run_id`.
- Gates L0–L3 are deterministic, pure over candidate JSON-LD.

## What Phase 3 adds (plan §7 items 1–4)

1. Backup-before-touch (already have `backupAsset`; wire it to the run).
2. Stage on an unpublished theme → **L4 live-verify** → publish/swap.
3. Auto-rollback on any hard-gate failure (incl. L4).
4. Circuit breakers: N consecutive failures, `maxCostUsd`, failed-rollback → page.

---

## Proposed architecture

### New: `src/lib/agent/verify.ts` — L4 live verify
`l4Verify(previewUrlForEntry, entry)`: fetch the *rendered* page from the staging
theme's preview, extract JSON-LD (reuse `extractJsonLd` + `validateSchema`), assert
the entry's required types appear AND validate live. Pure-ish: takes an injectable
fetcher so unit tests never hit the network. Returns a `GateResult` (L4).

### New: `src/lib/agent/apply.ts` — staging + swap + rollback orchestration
`applyRun(goal, runId, entries, ctx)`:
1. **Backup** live `theme.liquid` (+ snippet if present) → `theme_backups` keyed by runId.
2. **Stage**: duplicate live theme → unpublished staging theme.
3. **Write** snippet + include to the staging theme (`installSchemaGen({themeId: stagingId})`).
4. **L4 verify** each entry against `https://<shop>/<path>?preview_theme_id=<stagingId>`.
5. All pass → `themePublish(stagingId)` (atomic swap; live never saw unverified state).
6. Any fail → **auto-rollback**: do NOT publish, delete the staging theme (live untouched
   = inherently byte-identical), mark actions `rolled_back`, continue/halt per policy.

### New: `src/lib/agent/breakers.ts` — circuit breakers (pure)
A `Breakers` accumulator: `consecutiveFailures`, `costUsd`, `rollbackFailed`. After
each page: if `consecutiveFailures >= maxConsecutive` OR `costUsd > maxCostUsd` OR
`rollbackFailed` → halt the run (`rollbackFailed` pages the user; never thrash).

### Changed: `src/lib/agent/run.ts`
`runGoal` gains a real live path: when `dryRun:false`, after staging entries it calls
`applyRun`, threads breaker state, and records `write`/`verify`/`rollback` audit rows
with `writeTarget` set. Dry-run path is unchanged (still default).

---

## Open questions for eng review

### Q1 — Staging-theme duplication mechanism (the thorny one)
Shopify REST has **no clean "duplicate theme N"** call. `themeDuplicate(name, src)`
creates from a zip `src` we don't have. Options:
- **(a) GraphQL `themeDuplicate` mutation** — exists in modern Admin GraphQL; adds a
  GraphQL path to the client.
- **(b) In-place on the live theme** with backup → write → L4 → restore-on-fail (plan's
  explicit fallback: "If you must edit the live theme directly, still snapshot first and
  verify within the same run"). Simpler, fully reuses `safeAssetUpsert`/`restoreAsset`,
  but the live storefront briefly serves an unverified state until L4 passes.
- **(c) Pre-provisioned staging theme** re-synced each run.

Recommendation to debate: ship **(b) in-place-with-rollback as the concrete, tested
default** (matches the restore-byte-identical acceptance criterion directly and needs no
new API surface), while structuring `apply.ts` so a staging strategy (a/c) can slot in
without touching the breaker/verify/rollback logic.

### Q2 — Rollback granularity
Snippet is rendered from ALL entries at once → the write is one snippet asset + one
include line, not per-page. So rollback restores those two assets to their backed-up
values. Per-page "continue or halt" then means: a per-page L4 failure drops that entry
from the snippet set and re-renders, OR fails the whole apply. Recommendation: **fail the
apply atomically on any L4 failure** (restore both assets byte-identical), since a partial
snippet is still a single asset write — simpler and matches "the live storefront never
sees an unverified state." Per-entry pruning is a Phase 5 optimization.

### Q3 — What counts as a "consecutive failure" for the breaker
Gate failure (L0–L3, dry-run/stage) vs L4 live failure vs Shopify write error. Proposal:
all three increment the consecutive counter; a success resets it. `maxConsecutive`
default 3; `maxCostUsd` from `goal.constraints.maxCostUsd`.

### Q4 — Cost accounting
Phase 2 logs `costUsd: 0`. Where does real cost come from (LLM token usage in
`processPage`)? Is a per-page estimate acceptable for the budget breaker in Phase 3, with
true accounting deferred? Proposal: thread a cost estimate out of the executor; breaker
uses the running sum.

## LOCKED DECISIONS (eng review 2026-06-06)

- **D1 — Staging mode: HYBRID, ship in-place first.** `apply.ts` is built around a
  pluggable `ApplyStrategy`. The concrete, tested default is **in-place-with-rollback**:
  backup → write footprint to the live theme → L4-verify the live render → `restoreAsset`
  (byte-identical) on any failure. A true staging-theme strategy (GraphQL `themeDuplicate`
  → write copy → verify preview → `themePublish` swap) can slot in later without touching
  the breaker/verify/rollback logic. Tradeoff accepted: the live store may serve an
  unverified state for the seconds between write and L4 pass/rollback.
- **D2 — Rollback granularity: ATOMIC.** Any L4 failure restores the whole footprint
  (theme.liquid + snippet) to its backed-up value byte-identical and marks the run's writes
  `rolled_back`. No per-entry pruning (that is a Phase 5 optimization).
- **D3 — Cost breaker: MECHANISM now, real cost source Phase 5.** The breaker checks
  `costUsd > maxCostUsd` and is unit-tested with injected costs, but production `costUsd`
  stays `0` until Phase 5 threads real token accounting. Reconciliation of "budget breaker
  halts the run" (acceptance) with "defer cost plumbing" (D3 choice): the *behavior* is
  built and tested; only the *number's source* is deferred. TODO logged.

## Final architecture

```
runGoal(goal, {dryRun:false})
  PERCEIVE ─ plan ─ EXECUTE loop ──(per page)──▶ executeTask  (LLM, gates L0–L3, stage entry)
                                        │
                                        ├─▶ breakers.recordOutcome({success, costUsd})
                                        └─▶ breakers.tripped()? ── halt run (no apply)
  if !dryRun and entries:
     applyEntries(goal, runId, entries, ctx, strategy=inPlace, deps)
        1. backupAsset(theme.liquid) [+ snippet if present]   → theme_backups(run_id)
        2. installSchemaGen(live)  (snippet + idempotent include)   ── write 'verify' rows
        3. for each entry: l4Verify(liveRenderedUrl)  (fetch → extract → validate live)
        4. all L4 pass → APPLIED (record write/verify, writeTarget set)
           any L4 fail → restoreAsset(both) byte-identical → ROLLED_BACK, breaker++
        5. restore throws → RollbackFailedError → breaker.rollbackFailed → PAGE (halt)
```

New modules (all pure / dependency-injected so unit tests never hit network or Shopify):
- `src/lib/agent/breakers.ts` — `makeBreakers(cfg)`, `recordOutcome`, `tripped()` → `{halted, reason}`.
- `src/lib/agent/verify.ts` — `l4Verify({fetchHtml, url, requireTypes, minOutcome})` → `GateResult` (L4). Reuses `extractJsonLd`, `validateSchema`, `hasCriticalIssue`.
- `src/lib/agent/apply.ts` — `applyEntries(...)` orchestration + `ApplyStrategy` (inPlace default).
Changed: `run.ts` (live path + breaker threading), `types.ts` (L4 in `GateResults`, `BreakerConfig`, `ApplyResult`, `RunOptions` extension), `index.ts` (exports).

### Production failure mode — async asset propagation
Shopify asset writes are eventually consistent: an HTTP fetch of the live render right
after `assetUpsert` can see the OLD html, making L4 falsely fail. `l4Verify` (or its caller)
must poll-with-timeout for the rendered marker to appear (reuse the `waitForAsset` pattern
from `install.integration.test.ts`), with an injectable clock/sleep so unit tests are instant.

## Test coverage map (target: 100% of new branches)

```
CODE PATHS
[+] src/lib/agent/breakers.ts
  ├── recordOutcome / tripped()
  │   ├── [★★★] N consecutive failures → halted, reason="consecutive_failures"
  │   ├── [★★★] success resets the consecutive counter
  │   ├── [★★★] costUsd sum > maxCostUsd → halted  (INJECTED cost; D3 mechanism)
  │   ├── [★★★] rollbackFailed flag → halted, reason="rollback_failed", terminal
  │   └── [★★ ] under all thresholds → not halted
[+] src/lib/agent/verify.ts  (l4Verify, injected fetchHtml)
  │   ├── [★★★] live render has valid required type → L4 pass
  │   ├── [★★★] snippet didn't render (no JSON-LD extracted) → L4 fail
  │   ├── [★★★] required type missing in live render → L4 fail
  │   ├── [★★ ] required type present but invalid live → L4 fail
  │   ├── [★★★] fetch throws / non-200 → L4 fail (returns GateResult, never throws)
  │   ├── [★★ ] minOutcome=rich_results_eligible + critical issue live → L4 fail
  │   └── [★★ ] stale render then marker appears on retry → L4 pass (propagation poll)
[+] src/lib/agent/apply.ts  (applyEntries, mocked asset layer + injected fetchHtml)
  │   ├── [★★★] all entries render live → APPLIED, footprint present, writeTarget set
  │   ├── [★★★] inject non-rendering snippet → L4 fail → restore → theme.liquid+snippet
  │   │         BYTE-IDENTICAL to before → result rolled_back → run continues   ◀ ACCEPTANCE
  │   ├── [★★★] restore itself throws → RollbackFailedError → breaker pages (halt)  ◀ ACCEPTANCE
  │   ├── [★★ ] backup is written BEFORE the first asset write (ordering)
  │   └── [★★ ] snippet present pre-run → both assets backed up (not just theme.liquid)
[~] src/lib/agent/run.ts  (live path)
  │   ├── [★★★] dryRun:false → applyEntries invoked, status reflects apply outcome
  │   ├── [★★★] N consecutive page failures → breaker halts mid-loop, NO apply  ◀ ACCEPTANCE
  │   ├── [★★ ] apply returns rolled_back → run finalizes with rolled_back actions
  │   └── [REGRESSION] dryRun:true path unchanged → existing run.test.ts stays green

ACCEPTANCE CRITERIA → TEST
  "L4 fails → auto-rollback byte-identical → continue"  → apply.ts test #2
  "budget breaker halts the run"                        → breakers.ts test #3 + run.ts test #2
  "rollback-failure pages instead of thrashing"         → apply.ts test #3
```

No `[→E2E]`/`[→EVAL]` needed beyond the existing `RUN_SHOPIFY_INTEGRATION` gated test,
which can be extended in a follow-up to exercise a real forced-rollback on the dev store
(the runbook's "watch a forced rollback cycle before prod" step).

## NOT in scope (deferred, with rationale)
- True staging-theme strategy (GraphQL `themeDuplicate` + publish/swap) — slot-in later (D1).
- Per-entry snippet pruning on partial L4 failure — Phase 5 optimization (D2).
- Real LLM token cost accounting — Phase 5; breaker mechanism shipped now (D3).
- Concurrency caps on theme writes, idempotent resume via `fix_attempted_at`, LLM response
  caching, sitemap quality filtering, 429 backoff tuning — all **Phase 5** (runbook + TODOS.md).
- L6 soft LLM judge — Phase 5, optional.

## What already exists (reused, not rebuilt)
- `backupAsset`/`restoreAsset`/`safeAssetUpsert` — rollback primitive (write-failure path done).
- `installSchemaGen` — footprint write (snippet + idempotent marker include).
- `themeDuplicate`/`themePublish` — staging primitives (for the future strategy).
- Gates L0–L3, `runGoal` perceive/plan/execute loop, `createRun`/`recordAction`/`finishRun` audit.
- `extractJsonLd`, `validateSchema`, `hasCriticalIssue` — reused inside `l4Verify` (no new validation).

## Acceptance criteria (must pass)
- Inject a non-rendering snippet → L4 fails → auto-rollback restores **byte-identical** →
  run continues.
- Budget breaker halts the run (mechanism + injected cost; D3).
- Rollback-failure **pages** instead of thrashing.
- `npm run verify` green; no live Shopify calls in unit tests.
