# Phase 7 — Run readability

Source of truth: `AGENT_IMPLEMENTATION_PLAN.md` §9 (extends the build phases) and the QA-script
gaps in `docs/agent/QA_SCRIPT.md` Appendix A. Definition of done: `npm run verify` green AND the
acceptance criteria below pass.

> **Why this phase exists.** The engine already produces a rich structured trace — per-page gate
> verdicts, an `outcome` reason, `haltedBy`, before/after schema — but the dashboard renders almost
> none of it. A run that halts after 3 consecutive failures shows as a bare "failed" badge with 3
> cryptic `L0–L4` chip rows and 30 pages silently missing. **You cannot narrate (Phase 8) what the
> UI does not expose.** Phase 7 surfaces the data we already have; it is mostly presentation work.

## Goal

After any run, the operator can answer without help: *Did it work? What did it do to each page?
Why did it stop? What do I do next?* — and every page is accounted for.

## What already exists (reuse, do not rebuild)

The streamed **done** payload already carries everything items 1–3 and 5 need — the UI just drops
it. Confirmed during eng review:

```
done SSE payload (route.ts:161-175)          typed in DoneSummary?   rendered today?
  status, killed, dryRun, pagesTouched ............ yes ............. partial
  satisfied[]   (⊇ skipped — see grouping) ........ yes ............. count only
  unsatisfied[] ................................... yes ............. count only
  skipped[]     (committed + already-good) ........ yes ............. NO   ← item 3
  haltedBy      ("consecutive_failures" | …) ...... yes ............. NO   ← item 1
  stagedSnippet, apply ............................ yes ............. partial
per-event:  perceive {url}  → client accumulates all URLs ........... NO   ← item 3
            act {url, gates, …}  (NO outcome yet) .................... chips only  ← item 4
per-page schemaBefore/After + outcome → persisted; GET /api/agent/run/<id> returns them
```

So **items 1, 2, 3, 5 are UI-only edits to `AgentRunner.tsx`.** The only backend touch is item 4.

## Scope

1. **Headline verdict in English** (UI-only). Replace the bare `failed` chip with a one-line
   outcome + reason from `DoneSummary` (`status`, `killed`, counts, `haltedBy`): e.g. "Stopped
   early — 0 of 33 pages fixed. 3 pages failed in a row, so the agent halted to avoid wasting the
   other 30." `haltedBy` is already in the done payload (`route.ts:172`).

2. **Gate legend + plain labels** (UI-only). Map `L0–L4` to human labels with a "?" legend:
   Built (L0) · Valid (L1) · Rich-eligible (L2) · No-regression (L3) · Live-verified (L4). Keep the
   deterministic chip semantics from `gates.ts`; only the presentation changes.

3. **Account for every page, grouped by status** (UI-only). Accumulate all perceived URLs
   client-side (the `perceive` events already carry per-URL `url`), then group at done into:
   **Fixed**, **Already good** (skipped), **Failed** (with reason), **Not reached** (a breaker/kill
   cut them off). The 30 missing pages become an explicit "Not reached — halted before these" group.

   **Grouping math (eng-review D2 — known trap).** `RunResult.satisfied` is built as
   `[...committedSkipped, ...planned.skipped, ...acted-ok]` and **already contains every `skipped`
   page** (`run.ts:279-289`). Naive "Fixed = satisfied" double-counts already-good pages. Correct:
   - `Fixed = satisfied − skipped`
   - `Already good = skipped`
   - `Failed = unsatisfied`
   - `Not reached = perceivedURLs − satisfied − unsatisfied`

   Put this in a **pure, unit-tested helper** `groupRunPages(summary, perceivedUrls)` (NOT inline in
   JSX) returning `{fixed, alreadyGood, failed, notReached}`. The component renders its output.

4. **Per-page "what it did" detail** (eng-review D1 — hybrid). Stream the executor's `outcome`
   string in the `act` event (add `outcome?: string` to `AgentProgressEvent`; emit it at
   `run.ts:333`) so the failure reason (`gate_failed` vs `processing_failed: <ai reason>`,
   distinguished at `executor.ts:67`) shows **live**, no click. On row-expand, **lazy-load**
   before→after schema from `GET /api/agent/run/<id>` (already returns the `ActionRecord`s) rather
   than bloating the stream. The expand MUST degrade to "details unavailable" on 404 / network
   error / not-yet-persisted action — never a blank or spinning panel.

5. **A next-step affordance on failure** (UI-only). When a run fails/halts, show 2–3 concrete
   actions (e.g. "See the generated schemas", "Loosen required types", "Retry"). Phase 7 may stub
   these as links/hints; wiring them to act is Phase 9.

## Design constraints (from project memory)

- AI/fix affordances use **indigo**; **no orange** for non-warning states (a halted-but-safe run is
  not error-orange — reserve red/amber for genuine failure/rollback).
- Status cards/banners match the dashboard card motif; no gradient blobs.

## Tests (required — implementation writes these alongside the code)

- `lib/agent/__tests__/run-grouping.test.ts` (NEW) — unit-test `groupRunPages`:
  the satisfied⊇skipped overlap (Fixed excludes already-good), not-reached derivation,
  killed-mid-perceive (perceived < total), and the empty run (0 perceived → all groups empty, no
  throw). Target ★★★ (behavior + edges).
- Extend `lib/agent/__tests__/run.progress.test.ts` — assert the `act` progress event now carries
  the `outcome` string.
- Component (`AgentRunner.tsx`): no React unit-test infra exists in this repo; verify via
  `docs/agent/QA_SCRIPT.md` S1 and `/qa`. The row-expand failure path ("details unavailable") is a
  manual-QA checkpoint.

## Failure modes (new codepaths)

| Codepath | Failure | Test? | Error handling? | User sees |
|----------|---------|-------|-----------------|-----------|
| `groupRunPages` overlap | already-good counted as Fixed | unit ✓ | n/a (pure) | correct groups |
| `groupRunPages` empty run | throw on 0 perceived | unit ✓ | guard | empty state |
| row-expand fetch | 404 / network / unpersisted action | manual | **required** | "details unavailable" |
| `act` outcome field | missing on older events | n/a (optional) | optional chain | reason omitted, no crash |

No **critical gaps**: every failure above has either a test or explicit error handling, and none is
both silent and unhandled (the row-expand path is the one to watch — it must show the fallback).

## NOT in scope (deferred)

- Streaming full `schemaBefore`/`schemaAfter` in the live stream (D1 rejected — lazy-load instead).
- Making the next-step affordance buttons actually act (resume/retry/loosen) — that is Phase 9.
- Listing pages that were never perceived (killed-during-perceive) — Not-reached only covers
  perceived-but-unacted pages. Documented limit; revisit if it bites.
- Any LLM narration — that is Phase 8.
- React component-test infrastructure (testing-library/jsdom) — out of scope; covered by QA.

## Design (plan-design-review — IA, states, accessibility)

### Information architecture — result card (decision 1)

State-dependent hierarchy. The most decision-relevant group is always on top and expanded; the
rest collapse. The verdict sentence is the largest element on the card.

```
┌─ Result ─────────────────────────────── [⏹ Stopped early] ─┐  ① VERDICT (largest text)
│  0 of 33 product pages fixed.                               │
│  3 pages failed in a row (invalid Product schema), so the   │  ② one-line reason (haltedBy)
│  agent halted before the other 30.                          │
│                                                             │
│  What to do next:  [Loosen required types]  [See schemas]   │  ③ next-step CTA (failures only)
│                                                             │
│  ── Pages ──────────────────────────────────────────────   │  ④ groups, OUTCOME-ORDERED:
│  ❌ Failed (3)             ▾ open by default                │     failed run → Failed first/open
│     /products/duffel   Valid ✗ — no valid Product…    ›    │     success run → Fixed first/open
│  ⏸ Not reached (30)       ▸ collapsed                      │     boring groups collapsed
│  ✅ Fixed (0)   ·  ⏭ Already good (0)   ▸ collapsed         │
└─────────────────────────────────────────────────────────────┘
```

Next-step actions are plain text buttons in the existing button style — not a decorative
icon-in-circle row.

### Run-state matrix (decision 2)

Every outcome gets explicit verdict copy and group/empty UX — not just the failure state.

```
RUN STATE            | VERDICT LINE                          | GROUPS / EMPTY UX
---------------------|---------------------------------------|----------------------------
Running (live)       | "Scanning 12/33…" (existing progress) | rows stream in (exists)
All fixed (success)  | "✓ 33 of 33 fixed"  (celebratory)      | Fixed open; empty groups hidden
Partial              | "18 of 33 fixed · 3 failed"           | Failed open, Fixed below
All failed / halted  | "Stopped early — 0 of 33 fixed"       | Failed open + reason
Already-good only    | "Nothing to fix — all 33 already valid"| Already-good open, warm
Empty (0 perceived)  | "No pages found"                      | warm empty state + action
```

Empty state is a feature, not "No items found": "No pages found — the sitemap returned nothing.
Check the domain, or run with **Specific URLs**." Already-good-only must read clearly so a clean
store never looks like a broken one.

### Accessibility & responsive (decisions 3 + 4)

- **Chips:** each gate chip gets an `aria-label` (e.g. "Valid: failed — no valid Product schema").
  The failure reason renders as **visible text** per row (the streamed `outcome` from item 4), NOT
  a hover `title` — hover is absent on touch and unreliable for screen readers. Keep the ✓/✗
  glyphs so meaning is never color-only. The `n/a` chip is either darkened to a readable contrast
  (≥4.5:1) or non-applicable gates simply aren't rendered.
- **Rows / expand:** the row-expand is a real `<button>` (or `<details>`) with `aria-expanded`, a
  visible focus ring, and Enter/Space activation. Touch target ≥44px.
- **Responsive:** at `<640px` rows stack — URL on its own line, chips wrap below, expand control
  full-width and tappable. Desktop keeps the single-line layout.

## Process

1. Add `groupRunPages` (pure) + its unit tests.
2. Add `outcome?` to `AgentProgressEvent`; emit it in the `run.ts` act event; extend the progress test.
3. Surface `haltedBy` + headline verdict; gate legend; render the four groups from `groupRunPages`.
4. Wire row-expand lazy-load with the "details unavailable" fallback.
5. Add the failure next-step affordance (stubbed).
6. Run `npm run verify` and fix until green.

## Acceptance criteria

- `npm run verify` is green.
- A halted run states *why* it stopped in one sentence (names the breaker reason), not a bare badge.
- Every perceived page appears in exactly one group; counts reconcile with summary totals, and
  already-good pages are NOT counted as Fixed.
- Each `L0–L4` chip has a discoverable plain-language label/legend.
- A failed page shows its reason (gate vs AI processing failure) **live**, without hovering or expanding.
- Row-expand shows before/after on success and "details unavailable" on fetch failure.
- The result card follows the state-dependent hierarchy (verdict → reason → next-step → outcome-
  ordered groups); the lead group is expanded, the rest collapsed.
- Every run state renders distinct, legible copy — success, partial, already-good-only, and empty
  (0 pages) included; the empty state offers a concrete next action.
- Chips carry `aria-label`s, the failure reason is visible text (not hover-only), the `n/a` chip
  meets contrast, and the row-expand is keyboard- and touch-operable (≥44px, `aria-expanded`).
- Page rows stack legibly at 375px.
- No change to gate semantics or the control loop — `lib/validation` still judges; LLM still off
  the decision path.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 2 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (FULL) | score 6/10 → 9/10, 4 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **Eng decisions:** D1 stream `outcome` + lazy-load schema; D2 pure tested `groupRunPages` helper.
- **Design decisions:** state-dependent hierarchy; full run-state matrix (success/partial/already-
  good/empty); accessible chips (aria-labels + visible reason, n/a contrast); responsive rows +
  keyboard/touch expand.
- **UNRESOLVED:** 0
- **VERDICT:** ENG + DESIGN CLEARED — ready to implement.
</content>
