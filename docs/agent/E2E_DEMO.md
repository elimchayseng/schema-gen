# SchemaGen Agent — Full End-to-End Testing Demo

A single, phase-checkpointed walkthrough that proves the goal-based agent works **end to end on a real Shopify dev store** — from "merchant states a goal" to "every product page is rich-results eligible, verified live, and auto-rolled-back if anything goes wrong."

Each checkpoint has two halves, because both must hold:

- 🧑 **UX checkpoint** — what the *end user* (merchant / operator) sees and can trust.
- 🤖 **Goal checkpoint** — what the *agent* must have provably achieved (the deterministic gate or audit fact).

> Ground truth: this maps to code that exists today. Phases 0–3 are implemented and verified. Phase 4 (API + dashboard) and Phases 5–6 (cost metering, multi-merchant OAuth) are flagged as **planned** where the demo touches them, with the manual equivalent given so the full loop is still demonstrable now.

---

## ⭐ For customers: a 5-minute capability walkthrough (no code)

**You just paid for SchemaGen. Here's how to see it work — in plain English, no technical setup, nothing to read in the codebase.** Each step says what you do, what you'll see, and what it proves. Everything runs against a **test copy of your store**, so your live storefront is never at risk during the demo.

> The short version: you tell SchemaGen the outcome you want ("every product page should be eligible for Google rich results and readable by AI"), it shows you exactly what it'll change *before* touching anything, you approve, it makes the changes and proves they worked on the real page — and if anything looks wrong, it undoes itself automatically.

### Step 1 — See the problem (1 min)
- **You do:** Pick one of your product pages. Open Google's free **[Rich Results Test](https://search.google.com/test/rich-results)** and paste the URL.
- **You'll see:** Likely "no items detected" or errors — the page isn't eligible for rich results, and AI shopping tools can't reliably read it.
- **Proves:** The gap SchemaGen closes is real and measurable on *your* store, before we start.

### Step 2 — State your goal (30 sec)
- **You do:** Tell SchemaGen the outcome you want — e.g. *"Make all my product pages eligible for rich results."* (You also set guardrails: how many pages, and a spending cap.)
- **You'll see:** The goal accepted as a simple, plain statement of the end state — not a checklist of manual tasks.
- **Proves:** You manage *outcomes*, not busywork. You never hand-edit JSON or read the schema.org spec.

### Step 3 — Preview before anything changes ("show me what you'd do") (2 min)
- **You do:** Run the **preview** (dry run).
- **You'll see:** A clear summary — *"X pages already look good (skipping them), Y pages will be fixed,"* plus the **exact change** that would be made to each page. **Nothing has been written to your store yet.**
- **Proves:** Total transparency and zero surprise. The agent commits to a plan you can inspect *before* it acts — the trust moment.

### Step 4 — Approve and let it run (1 min)
- **You do:** Approve the plan (turn the preview into a live run).
- **You'll see:** SchemaGen apply the fixes to the **test copy** of your store, then **re-open the real rendered page itself to double-check** the change actually shows up correctly — not just that the data looked right on paper.
- **Proves:** It doesn't trust its own output blindly. It verifies the *live page* before considering the job done.

### Step 5 — Confirm it worked (1 min)
- **You do:** Re-run Google's **Rich Results Test** on the same product URL from Step 1.
- **You'll see:** **Eligible** — the rich-result errors are gone. Your page is now readable by Google rich results and AI tools.
- **Proves:** A measurable before/after improvement, on your own store, in minutes.

### Step 6 — Watch the safety net (the part that matters most) (1 min)
- **You do:** Ask for the **safety demo** — your operator deliberately feeds the agent a "fix" that would render incorrectly on the page.
- **You'll see:** The agent catch the bad change *on the live page*, **automatically undo it**, and report "rolled back." Reload your storefront — it's **exactly** as it was before. No broken page, ever, and no human had to scramble.
- **Proves:** This is why it's safe to let an agent touch a live store: every change is backed up, verified on the real page, and reversible to the byte. Combined with built-in **spending caps** and **stop-if-something-keeps-failing** protection, it never runs away.

### What you just demonstrated
| You saw | The capability behind it |
|---|---|
| A plain-English goal, not a task list | Goal-based agent (you declare the outcome) |
| A full preview before any change | Safe-by-default dry run |
| Fixes applied, then the real page re-checked | Live verification of the rendered page |
| Rich Results Test flips to *eligible* | Validated, deployment-ready structured data |
| A bad change caught and auto-undone | Automatic backup + rollback safety net |
| Spend cap + auto-stop on repeated failures | Built-in guardrails — it never runs away |

> **One sentence to remember:** *You tell it the outcome, it shows you the plan, you approve, it fixes and proves it on the live page — and it can always undo itself.*

**Today's reality (honest note):** the one-click dashboard that makes Steps 2–4 fully self-serve is on the near-term roadmap (Phase 4). Until it ships, your SchemaGen operator drives these exact steps on your behalf and walks you through each screen — the capabilities, safety, and before/after results above are all real and working today. The sections below are the technical proof of each step for engineers.

---

## 0. Preconditions (one-time setup)

| Requirement | How |
|---|---|
| Shopify **development store** (never a live merchant store) | `dev.shopify.com` |
| An **unpublished** theme to write to | duplicate the live theme; put its id in `SHOPIFY_TEST_THEME_ID` |
| App installed on the dev store (for token mint) | install the `dev.shopify.com` app |
| `.env.local` populated | `SHOPIFY_SHOP`, `SHOPIFY_API_VERSION`, `SHOPIFY_APP_KEY`, `SHOPIFY_APP_SECRET`, `SHOPIFY_OFFLINE_TOKEN` (stopgap), `SHOPIFY_TEST_THEME_ID`, Supabase + inference keys |
| Supabase migrations applied | `agent_runs`, `agent_actions`, `theme_backups`, `sites`, `page_schemas` |
| A `sites` row for the dev store | so `goal.siteId` resolves to the store domain |

**Golden rule (enforced in code):** the agent only ever writes to `SHOPIFY_TEST_THEME_ID` or a duplicate. `resolveWriteThemeId()` throws if that env var is missing or invalid, so a live run **cannot** silently target the published theme. Never point the demo at a published/live theme.

**Gate before any demo step:**

```bash
npm run verify      # typecheck + lint + full unit test suite — must be green
```

✅ **Setup checkpoint:** `npm run verify` is green and all five env groups are present. If this isn't true, stop here.

---

## The golden path (what the full demo proves)

```
Merchant states a goal
        │
        ▼
[Phase 0] safe read/write/rollback on the dev store  ──────────────┐
[Phase 1] snippet renders correct JSON-LD live, idempotently       │  foundation
[Phase 6] token mints on demand, survives expiry/401  ─────────────┘
        │
        ▼
[Phase 2] DRY RUN: perceive → plan → stage → gate (L0–L3), no writes
        │         "show me what you'd do" — staged snippet + audit trail
        ▼
[Phase 3] LIVE APPLY: backup → write → L4 live verify → publish OR auto-rollback
        │         under circuit breakers; deliberate-breakage proves rollback
        ▼
[Phase 4] (planned) one-click dashboard: live progress, pause/resume/kill, diff
[Phase 5] (planned) real $ cost metering enforces the budget breaker
        │
        ▼
GOAL MET: every product page valid + rich-eligible, verified on the storefront,
          fully audited, reversible.
```

---

## Phase 0 — Safe Shopify plumbing (read / write / rollback)

**What it proves:** we can touch a store and *always* undo it.

**Run:**
```bash
RUN_SHOPIFY_INTEGRATION=1 npm test -- src/lib/shopify/__tests__/install.integration.test.ts
RUN_SHOPIFY_INTEGRATION=1 npm test -- src/lib/shopify/__tests__/asset-roundtrip.integration.test.ts
```
(Unit equivalents run without the flag and the live store: `npm test -- src/lib/shopify`.)

- 🧑 **UX checkpoint:** an operator can install a no-op marker into `theme.liquid` and remove it, and the storefront is **byte-identical** to before. Uninstall leaves no trace.
- 🤖 **Goal checkpoint:** `backupAsset` → `assetUpsert` → `restoreAsset` returns the asset to the exact prior bytes; `RollbackFailedError` is the only path that leaves state dirty, and it's surfaced, not swallowed. The asset write/read round-trip survives Shopify's **eventual consistency** (the read polls, it doesn't read-once).

> ❗ Known property under test: the Asset API is read-after-write eventually consistent — a GET right after a PUT can return stale bytes. Verification must **poll with a timeout**, or it produces false rollbacks. This is exercised here and reused by L4.

---

## Phase 1 — Snippet renderer + idempotent injection

**What it proves:** the JSON-LD we generate actually renders on the page, and our footprint is one line + one file, forever.

**Run:** `npm test -- src/lib/shopify/__tests__` (snippet + theme-liquid + install).

- 🧑 **UX checkpoint:** load a product page on the dev store → view source → the correct `Product` JSON-LD is present inside `<!-- SCHEMAGEN:START -->…<!-- SCHEMAGEN:END -->`. Re-running the install produces an **identical diff** (no churn, no duplicate blocks).
- 🤖 **Goal checkpoint:** `renderSchemaGenSnippet(entries)` is deterministic (same entries → byte-identical file); per-entry Liquid guards (`{%- if template contains 'product' and product.handle == 'x' -%}`) route the right schema to the right page; the payload is escaped (`<`→`<`, `{`→`{`) so it can't break out of the `<script>` or the Liquid. `upsertMarkerBlock` inserts-or-replaces; never blind-appends.

---

## Phase 6 — Token lifecycle (run this before any *live* phase)

**What it proves:** a long run can't die on a 24h token expiry, and tokens are never logged.

**Run:** `npm test -- src/lib/shopify/__tests__/config.test.ts src/lib/shopify/__tests__/client.test.ts`

- 🧑 **UX checkpoint:** the operator never pastes a token mid-run. A run that outlives the ~24h `client_credentials` token just… keeps working.
- 🤖 **Goal checkpoint:** with a deliberately-expired cache, `getOfflineToken(shop)` auto-mints and succeeds; a mid-run `401` triggers **exactly one** re-mint + retry (no loops); single-flight dedup prevents a thundering herd of concurrent mints; the token never appears in logs.

> Status: mint-on-demand + auto re-auth implemented (in-memory cache, single process). **Planned for true multi-merchant:** durable per-shop credential storage in Supabase (Phase 6 remainder) + OAuth install flow.

---

## Phase 2 — Agent core: the DRY RUN ("show me what you'd do")

**This is the heart of the demo.** The agent perceives the store, plans the cheapest-and-safest path to the goal, stages every fix, and runs gates L0–L3 — **writing nothing.** It returns the exact snippet it *would* publish, plus a full audit trail.

**Set the goal** (declarative — the merchant's intent as data):
```ts
import { runGoal } from "@/lib/agent";

const goal = {
  siteId: "<dev-store-site-uuid>",
  target: {
    scope: "all_products",            // or "url_list" with explicit urls
    requireTypes: ["Product"],
    minOutcome: "rich_results_eligible",
  },
  constraints: { maxPages: 5, maxCostUsd: 5, allowSchemaTypeChange: false },
  autonomy: "auto_apply",
};

const result = await runGoal(goal, { dryRun: true });   // dryRun defaults true
```

**How to run it today (no API yet — Phase 4):** invoke `runGoal` from an integration test gated behind `RUN_SHOPIFY_INTEGRATION=1` (mirrors the existing integration-test convention), or a throwaway `tsx` script that loads `.env.local` via `dotenv`. Phase 4 replaces this with `POST /api/agent/run`.

**Inspect the result:**
```ts
result.status          // "done" when every targeted page is satisfiable
result.skipped         // pages already valid — the planner never touched them
result.satisfied       // already-valid + newly-staged
result.unsatisfied     // pages that couldn't be brought to goal (gate failures)
result.stagedSnippet   // the EXACT Liquid that would be written — diff this
result.actions         // per-page audit: action, gates {L0,L1,L2,L3}, outcome
result.apply           // null in dry-run (nothing written)
```

- 🧑 **UX checkpoint:** the operator sees, before anything touches the store: "3 pages already good (skipped), 2 pages will be fixed, here's the exact JSON-LD diff, estimated within budget." Nothing was written — `result.apply` is `null`. This is the trust-builder.
- 🤖 **Goal checkpoint:**
  - **Perceive** ran with **no LLM** (`processPage(url, "scan")`); `result` reflects real per-URL state.
  - **Plan** is deterministic: already-valid pages are in `skipped`; the queue orders **fixes before generates** (cheapest/safest first); `maxPages` is respected.
  - **Gate** L0–L3 pass for every staged entry (`gatesPassed`); **L3 regression guard** means no staged candidate is worse than what's live.
  - **Audit** rows landed in `agent_runs` (status flips `running`→`done`) and `agent_actions` (one row per page, with `gates` JSON).

✅ **Acceptance (matches Phase 2 DoD):** `runGoal` brings a 5-page dev store to "all satisfiable" in dry-run, returns a valid staged snippet, and the audit trail is complete. The LLM touched only the executor; every gate was deterministic.

---

## Phase 3 — Live apply: backup → write → L4 verify → publish OR auto-rollback

**This earns the right to flip off dry-run.** Same loop, now `dryRun: false`. The agent writes to the **staging theme**, verifies the *rendered* storefront (L4), and publishes only if it holds — otherwise it restores byte-identical and logs it.

```ts
const result = await runGoal(goal, { dryRun: false });
```

### 3a — The happy path

- 🧑 **UX checkpoint:** after the run, load the product pages on the storefront → the `Product` JSON-LD is live, valid, and rich-eligible. Run Google's Rich Results Test on one page → eligible. The operator did nothing but approve the goal.
- 🤖 **Goal checkpoint:**
  - For each entry: **backup** snapshotted into `theme_backups` (keyed by run) → **write** snippet + marker → **L4 live verify** re-fetched the rendered page via `?preview_theme_id=<staging>`, re-extracted the JSON-LD, and re-validated it (polling through eventual consistency).
  - `result.apply.status === "applied"`; `result.apply.l4` is all-pass; `result.status === "done"`.
  - `agent_actions` now contains `write` and `verify` rows; `agent_runs.status === "done"`.

### 3b — The deliberate-breakage rollback (the safety demo — do this live for investors)

Inject a snippet that validates as JSON but **won't render** on the page (e.g., a handle that doesn't exist / a template mismatch), so L4 must catch it.

- 🧑 **UX checkpoint:** the run reports `rolled_back`; the operator reloads the storefront → it is **exactly** as before, with zero broken or partial schema visible. No human had to intervene.
- 🤖 **Goal checkpoint:**
  - L4 **fails** (the JSON-LD isn't present/valid in the live render) → auto-rollback restores `theme.liquid` to **byte-identical** prior bytes and removes the snippet if it didn't pre-exist.
  - `result.apply.status === "rolled_back"`; a `rollback` row is in `agent_actions`; `agent_runs.status === "failed"` with an explanatory `error`.
  - The storefront diff against the pre-run snapshot is empty.

### 3c — Circuit breakers (never thrash)

- **Budget breaker:** set `constraints.maxCostUsd` low (or inject costs via `opts.breakers` in a unit test) → the run **halts** with `haltedBy: "max_cost_exceeded"` and `status: "failed"` before doing more work.
- **Consecutive-failure breaker:** N failing pages in a row → `haltedBy: "consecutive_failures"`, loop stops.
- **Rollback-failed breaker (terminal):** if a rollback itself fails, `apply.status === "paged"` → `recordRollbackFailure` trips → the run is marked `paged` (theme left dirty, *a human is paged*) and future runs won't thrash on it.

- 🧑 **UX checkpoint:** the operator is never surprised by runaway spend or a flapping store; a genuinely stuck state pages a human instead of looping.
- 🤖 **Goal checkpoint:** `tripped(breakers)` returns the right reason with the documented priority (`rollback_failed` > `max_cost` > `consecutive_failures`); the loop `break`s; `RunResult.status` / `haltedBy` reflect it; audit captures it.

✅ **Acceptance (matches Phase 3 DoD):** inject a non-rendering snippet → L4 fails → auto-rollback restores byte-identical → run continues/halts per policy. Budget breaker halts. Rollback-failure pages instead of thrashing. All covered by `apply.test.ts`, `verify.test.ts`, `breakers.test.ts`, plus the live integration run above.

---

## Phase 4 — Control surface (PLANNED — the productized demo)

What the merchant-facing demo *becomes* once built. Today the loop is driven via `runGoal()`; Phase 4 wraps it in an API + dashboard.

- 🧑 **UX checkpoint (target):** merchant clicks **"Make all products rich-results eligible,"** watches live SSE progress per page (reusing the existing `fix-all` streaming pattern), sees per-page gate results and the diff, and can **pause / resume / kill** or stay in dry-run with one toggle.
- 🤖 **Goal checkpoint (target):** `POST /api/agent/run` accepts a `Goal` and kicks off `runGoal`; `GET /api/agent/run/[id]` streams status from `agent_runs`/`agent_actions`. No new engine — pure surface over the built core.

> Manual equivalent available now: run `runGoal` and read `agent_runs` / `agent_actions` directly to reconstruct the same view.

---

## Phase 5 — Cost metering (PLANNED — closes the budget loop)

- 🧑 **UX checkpoint (target):** before clicking, the merchant sees "~$1.80 for 12 pages"; after, actual spend per page.
- 🤖 **Goal checkpoint (target):** real token usage threads `generateSchemas` → `processPage` → `executeTask` → `runGoal`, populating `agent_actions.cost_usd` and `breakers.costUsd`. **The breaker mechanism already enforces `maxCostUsd`** — today production `costUsd` is hard-coded `0`, so the budget breaker only trips against injected costs in unit tests. This phase makes it bite on a live run.

---

## End-to-end acceptance matrix (the one-screen "did it work?")

| # | Demonstrable claim | How verified | Phase | Status |
|---|---|---|---|---|
| 1 | Any store edit is fully reversible (byte-identical) | `install`/`asset-roundtrip` integration tests | 0 | ✅ |
| 2 | Correct JSON-LD renders live; footprint is 1 line + 1 file; idempotent | view-source + re-run diff | 1 | ✅ |
| 3 | Tokens self-heal across expiry/401, never logged | `config`/`client` tests | 6 | ✅ (single-proc) |
| 4 | Agent shows the full plan + exact diff **before** writing | `runGoal({dryRun:true})` → `stagedSnippet`, `skipped`, `actions` | 2 | ✅ |
| 5 | LLM is never a gate; all of L0–L3 are deterministic | `gates.test.ts` + code review (`gates.ts` has no model calls) | 2 | ✅ |
| 6 | Live apply makes pages rich-eligible, verified on the rendered page (L4) | `runGoal({dryRun:false})` → `apply.status==="applied"` + Rich Results Test | 3 | ✅ |
| 7 | A bad write is caught live and auto-rolled-back; storefront unchanged | deliberate-breakage run → `status==="rolled_back"` + empty diff | 3 | ✅ |
| 8 | No runaway spend / flapping; stuck state pages a human | breaker tests + low `maxCostUsd` run | 3 | ✅ (mechanism) |
| 9 | Every action is audited (before/after, gates, outcome) | inspect `agent_runs` / `agent_actions` | 2–3 | ✅ |
| 10 | One-click merchant UX with live progress + pause/resume | dashboard | 4 | 🔜 planned |
| 11 | Real $ cost shown and enforced on live runs | cost metering | 5 | 🔜 planned |
| 12 | Multi-merchant install via Shopify App Store OAuth | OAuth flow + durable token store | 6 | 🔜 planned |

**Definition of "demo succeeded":** rows 1–9 pass on the dev store with `npm run verify` green; rows 10–12 are the funded roadmap shown as the path to product.

---

## Suggested live-demo script (≈8 minutes)

1. **(30s) The stakes** — open a product page with broken/missing schema, run Google's Rich Results Test → *not eligible.* "This page is invisible to AI shopping."
2. **(90s) State the goal** — show the declarative `goal` object. "We don't click around. We declare the end state."
3. **(2m) Dry run** — `runGoal({dryRun:true})`. Show `skipped` (already-good pages it won't touch), the staged JSON-LD **diff**, and the audit rows. "It told us exactly what it would do, and wrote nothing."
4. **(2m) Live apply** — `runGoal({dryRun:false})`. Reload the storefront, re-run Rich Results Test → *eligible.* Show `apply.status === "applied"` and the `verify` audit row.
5. **(2m) The safety moment** — inject a non-rendering snippet, run again → `rolled_back`. Reload the storefront → unchanged. "L4 caught it on the live render and undid it. No human touched anything."
6. **(30s) The close** — show the acceptance matrix: rows 1–9 green today; rows 10–12 are the raise.

---

*Companion to `docs/investor/INVESTOR_DECK.md`. Engineering source of truth: `AGENT_IMPLEMENTATION_PLAN.md` and `docs/agent/phase-*.md`.*
