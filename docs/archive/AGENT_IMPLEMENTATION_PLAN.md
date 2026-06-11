# SchemaGen Agent — Implementation Plan

A goal-based agent that runs an autonomous sense → plan → act → verify loop and writes validated structured data into a Shopify store on the user's behalf.

**Decisions locked for this plan**
- **Write mechanism:** `theme.liquid` injection (Asset API)
- **Autonomy:** auto-apply with guardrails (validation + regression gate → write → auto-rollback on failure)
- **Harness:** custom lightweight in-repo TypeScript orchestrator (recommendation justified below)

---

## 1. Core principle: keep the LLM out of the control loop

The single most important reliability decision. SchemaGen's edge is that it already has a **deterministic** validation engine (`lib/validation/engine.ts`, 30+ types), an auto-fixer, rich-results checks, and a regression guard inside `refineAndValidate`. Structured data is a domain where correctness is *checkable in code* — you do not need an LLM to judge whether a schema is valid.

So the agent splits into two halves:

- **Controller (deterministic):** decides what to do, gates every change, commits or rolls back. Plain TypeScript. No model calls in the decision path.
- **Generator (LLM):** produces candidate JSON-LD from page content. Already wrapped in `lib/ai/refinement.ts`. The model proposes; the controller disposes.

Every quality gate is deterministic. The LLM is never a gate. This is what makes "reliable results for structured data" achievable.

---

## 2. Harness recommendation: build a small one, don't adopt a framework

You asked whether to use or build a harness. **Build a thin one in-repo.** Reasons specific to your situation:

- Your action space is tiny and fixed: crawl, generate, validate, render snippet, write asset, verify, rollback. That is a state machine, not an open-ended tool-use agent. Frameworks (LangGraph, Agent SDK) shine when the *model* needs to choose among many tools across unpredictable branches. Here the branching is deterministic and you want it that way.
- Reliability comes from your validation engine, not from the harness. A framework adds indirection and a second runtime model without buying you a single additional guarantee on schema correctness.
- You already have ~80% of the loop: crawl (`lib/crawl/sitemap.ts`), per-page pipeline (`lib/crawl/process-page.ts`), refinement (`lib/ai/refinement.ts`), validation gate (`canDeploy` in `lib/validation/integration.ts`), and an SSE progress pattern (`fix-all/route.ts`). The agent is mostly orchestration glue plus the missing Shopify write-back.
- Staying in your Next.js/Supabase stack means one deploy target, one auth model, one set of types. No new infra to get off the ground.

Reach for the Claude Agent SDK later only if you add genuinely open-ended steps (e.g. "investigate why this product page won't validate and decide among several repair strategies"). Until then it is overhead.

**What "the harness" actually is here:** a `lib/agent/` module exporting `runGoal(goalId)` that drives a typed state machine, plus two Supabase tables for run/action audit, plus a control surface (API routes + a dashboard reusing `/site/[id]` patterns).

---

## 3. The agent loop

```
        ┌─────────────────────────── GOAL ───────────────────────────┐
        │  e.g. "Every product page has valid Product schema with     │
        │   rich-results eligibility, no regressions."                │
        └──────────────────────────────┬──────────────────────────────┘
                                        ▼
   ┌────────────┐   ┌──────────┐   ┌──────────┐   ┌─────────────┐   ┌──────────┐
   │  PERCEIVE  │──▶│   PLAN   │──▶│   ACT    │──▶│   VERIFY    │──▶│  COMMIT  │
   │  crawl +   │   │ diff cur │   │ generate │   │ deterministic│   │ promote  │
   │  scan      │   │ vs goal  │   │ + render │   │ gates (L0-L4)│   │ or ROLL  │
   │            │   │ → queue  │   │ snippet  │   │              │   │  BACK    │
   └────────────┘   └──────────┘   └──────────┘   └─────────────┘   └────┬─────┘
        ▲                                                                  │
        └──────────────────── loop until goal met / budget hit ◀──────────┘
```

**1. Perceive** — reuse `crawlSitemap` + `processPage(url, "scan")` (no LLM, ~3–6s/page) to capture current per-URL schema state into `page_schemas`. This is your "world state."

**2. Plan** — deterministic diff of current state vs goal's target state. Output an ordered task queue: which URLs need which schema types fixed/added, cheapest-and-safest first (already-valid → skip; auto-fixable → next; needs-generation → last). No model call.

**3. Act** — for each queued URL: run the existing `refineAndValidate` loop to get candidate JSON-LD, then render it into a Liquid snippet (Section 5). Nothing is written live yet.

**4. Verify** — run the layered gates (Section 6) against the candidate *before* any live write.

**5. Commit / rollback** — write to a **staging (unpublished) copy** of the live theme, re-fetch the rendered preview, confirm the JSON-LD actually appears and validates live, then publish/swap. Any gate failure → discard and restore. This is the guardrail that makes auto-apply safe (Section 7).

**Termination:** goal satisfied, max iterations reached, or cost/error budget exceeded (circuit breaker).

---

## 4. Goal model

Make goals declarative — a target state plus constraints — so the planner can diff against reality and the loop has a definition of "done."

```ts
// lib/agent/types.ts
interface Goal {
  id: string;
  siteId: string;            // FK to existing sites table
  target: {
    scope: "all_products" | "all_pages" | "url_list";
    urls?: string[];
    requireTypes: SchemaType[];        // e.g. ["Product", "BreadcrumbList"]
    minOutcome: "valid" | "rich_results_eligible";
  };
  constraints: {
    maxPages?: number;
    maxCostUsd?: number;               // hard budget circuit breaker
    maxIterations?: number;
    allowSchemaTypeChange: boolean;    // gate novel type changes if false
  };
  autonomy: "auto_apply";              // locked for v1
}
```

Goals, runs, and actions are persisted so a run is resumable and fully auditable.

---

## 5. Shopify write-back via `theme.liquid` injection

You chose direct theme injection. Do it the *low-blast-radius* way — inject a single include, not a wall of JSON-LD into `theme.liquid` itself.

**App + auth — two-stage token strategy**

The Asset API always authenticates with an Admin API access token (`shpat_…`) in the `X-Shopify-Access-Token` header. The *only* thing that changes between dev-store testing and full distribution is **how that token is obtained**, captured behind the single `getOfflineToken(shop)` seam in `lib/shopify/config.ts`. Stage A is a strict subset of Stage B; nothing built in A is thrown away.

> **Finding (2026-06-06): the token is short-lived, not a classic offline token.** The store-admin "Develop apps" custom-app route (which used to hand out a durable `shpat_…` offline token) is no longer available on this org. Apps are now created in the new **`dev.shopify.com` developer dashboard**, which exposes only a **Client ID + Client secret** and issues tokens via the OAuth **`client_credentials`** grant:
> ```bash
> curl -X POST "https://<shop>.myshopify.com/admin/oauth/access_token" \
>   -H "Content-Type: application/x-www-form-urlencoded" \
>   -d "grant_type=client_credentials" \
>   -d "client_id=$SHOPIFY_APP_KEY" -d "client_secret=$SHOPIFY_APP_SECRET"
> ```
> The returned token **expires in ~24h** (`expires_in: 86399`) — it is **not** durable. Prerequisite: the app must already be **installed on the shop** (an un-installed app returns `400 app_not_installed`).

- **Stage A — dev-store testing (current).** Install the `dev.shopify.com` app on the dev store, then mint a token with the `client_credentials` curl above and place it in `SHOPIFY_OFFLINE_TOKEN`. Because the token expires in ~24h, treat the env value as a short-lived convenience for a single test session — for anything beyond that, use mint-on-demand (below). This exercises the *identical* write-back code path that ships.
- **Stage B — distribution (multi-merchant).** Same `dev.shopify.com` app, installed per merchant. Implement OAuth install + callback as **Next.js API routes** (`/api/shopify/auth`, `/api/shopify/callback`) — do **not** scaffold the Shopify CLI's Remix app template; SchemaGen is the app. Persist **per-shop credentials/install state**, not tokens.
- **Token lifecycle — mint-on-demand (replaces "store the encrypted token").** Because `client_credentials` tokens expire in ~24h, `getOfflineToken(shop)` should **exchange `client_id`/`client_secret` → token at runtime, cache it in-memory ~23h, and re-mint on expiry or on any `401`** — rather than persisting a long-lived token. This means the durable per-shop secret to store is the **install credential**, and tokens refresh themselves. (This supersedes §8's `encrypted offline token` storage assumption.)
- **Shopify CLI's role.** Stage A needs no CLI. For Stage B the CLI manages `shopify.app.toml` as config-as-code (scopes, app URLs, webhooks), `shopify app deploy` versions that config, and `shopify app dev` provides a tunnel for local OAuth testing. It never owns the web server — the Next.js app does.
- Use the Asset API (REST `PUT /admin/api/<v>/themes/{id}/assets.json`, or GraphQL `themeFilesUpsert`).

**Injection strategy (idempotent, removable)**
1. Write per-template JSON-LD to a managed snippet: `snippets/schemagen-jsonld.liquid`. Page logic lives here (`{% if template contains 'product' %}…{% endif %}`), keyed by product handle / template so each page emits the right schema.
2. Include it **once** in `theme.liquid` inside delimited markers so writes are idempotent and the whole footprint is one line + one file:
   ```liquid
   <!-- SCHEMAGEN:START -->{% render 'schemagen-jsonld' %}<!-- SCHEMAGEN:END -->
   ```
3. On every write: GET `theme.liquid`, replace only the marker block (insert if absent), PUT back. Never blind-append. Removal = delete the marker block + the snippet.

**Why a snippet, not inline:** `theme.liquid` stays a one-line diff forever; all churn is isolated to a file SchemaGen owns; uninstall is clean; and you avoid corrupting hand-edited theme code.

---

## 6. Quality checks in the loop (layered gates)

Every candidate passes all hard gates before commit. Cheapest checks first; fail fast.

| Layer | Check | Source | Gate? |
|------|-------|--------|------|
| **L0** | JSON parses | `JSON.parse` | hard |
| **L1** | schema.org valid (required props, enums, `@context`) | `validateSchema` / `canDeploy` | **hard** |
| **L2** | Rich-results eligibility (Product needs offers/price/availability, etc.) | `lib/validation/rich-results.ts` | **hard** for `minOutcome: rich_results_eligible` |
| **L3** | Regression guard — candidate is not worse than current live | regression logic already in `refineAndValidate` | **hard** |
| **L4** | Post-write live verify — re-fetch rendered preview, re-extract, confirm JSON-LD present + still valid | `fetchPage` + `extractJsonLd` + `validateSchema` | **hard**, triggers rollback |

> **Finding (2026-06-06): the Asset API is read-after-write eventually consistent.** A GET issued immediately after a successful PUT can return the *stale* value (verified in the Phase 0 integration test — the marker took several seconds to appear). L4 must therefore **poll** the re-fetch with a timeout, not read once, or it will produce false rollbacks. The Phase 0/1 integration tests already use a `waitForAsset(predicate, timeout)` helper that L4 should reuse.
| **L5** | Cost / iteration / error budget | run accounting | circuit breaker |
| **L6** | LLM-as-judge "does this match page intent?" | optional model call | **soft only** — logged, never blocks |

L1–L4 are deterministic. L4 is the one most agents skip and the one that catches Liquid that rendered wrong, caching, or a template that didn't pick up the snippet. Do not skip it.

---

## 7. Auto-apply guardrails (what makes direct theme editing safe)

Auto-applying to a live theme is the riskiest combination you picked. These guardrails are mandatory, not optional:

1. **Backup before touch.** Snapshot the current `theme.liquid` (and snippet, if present) asset value into a `theme_backups` row keyed by run. This is the rollback token.
2. **Stage on an unpublished theme.** Duplicate the live theme → write to the copy → verify against its preview URL (L4) → only then publish/swap. The live storefront never sees an unverified state. If you must edit the live theme directly, still snapshot first and verify within the same run.
3. **Auto-rollback.** Any hard-gate failure (including L4 live verify) → restore the backed-up asset value, mark the action `rolled_back`, continue or halt per policy.
4. **Circuit breakers.** Halt the whole run if: N consecutive page failures, cost exceeds `maxCostUsd`, or rollback itself fails (page the user). Never thrash.
5. **Idempotency + concurrency.** Reuse the `fix_attempted_at` pattern from `page_schemas` so a resumed run never re-processes a committed page. Cap concurrent theme writes (the TODOs already flag 3–5 concurrency); Asset API is rate-limited.
6. **Dry-run mode.** Same loop, writes to staging and reports the diff but never publishes. Make this the default until you trust it on a real store.
7. **Full audit trail.** Every action row records: before/after schema, gate results, cost, write target, outcome. This is your debugging and your undo.

---

## 8. Data model (additions)

Two new tables; reuse existing `sites` / `page_schemas`.

> **Note (see §5 token lifecycle):** tokens from the `dev.shopify.com` `client_credentials` grant expire in ~24h, so there is **no durable offline token to persist**. Store the per-shop **install credential** instead and mint tokens on demand. An encrypted-token table is therefore unnecessary for Stage B.

```sql
-- one row per goal execution
agent_runs(
  id, site_id, goal jsonb, status,           -- queued|running|paused|done|failed
  iterations int, pages_touched int,
  cost_usd numeric, started_at, ended_at, error text
)

-- one row per page action, append-only
agent_actions(
  id, run_id, url, action,                   -- generate|write|verify|rollback|skip
  schema_before jsonb, schema_after jsonb,
  gates jsonb,                               -- {L1:pass, L2:pass, L3:pass, L4:pass}
  write_target text,                         -- staging theme id / asset key
  outcome text, cost_usd numeric, created_at
)

-- rollback tokens
theme_backups(id, run_id, shop, asset_key, asset_value_before, created_at)
```

---

## 9. Build phases — get off the ground fast

Sequenced so each phase ships something testable on a dev store. Use a Shopify **development store** + an unpublished theme throughout.

**Phase 0 — Shopify plumbing (prove read+safe write).** *Highest priority, do this first.*
- OAuth install flow, offline token storage, Asset API client: `themeGet`, `themeDuplicate`, `assetGet`, `assetUpsert`, `themePublish`.
- `theme_backups` + restore. Acceptance: read `theme.liquid` from a dev store, write a no-op marker block, verify, roll back — all from a script. Until this is rock-solid, build nothing else.

**Phase 1 — Snippet renderer.** Map `page_schemas` → `snippets/schemagen-jsonld.liquid` with per-template/handle conditionals; idempotent marker insertion into `theme.liquid`. Acceptance: a product page renders correct JSON-LD live; re-running produces an identical diff (idempotent).

**Phase 2 — Agent core.** `lib/agent/`: `Goal` types, deterministic planner (diff current vs target → queue), executor wrapping `processPage` + `refineAndValidate` + the renderer, gates L0–L3, `agent_runs`/`agent_actions` audit. Acceptance: `runGoal` brings a 5-page dev store to all-valid in dry-run.

**Phase 3 — Guardrails + auto-apply.** Staging-theme workflow, L4 live verify, auto-rollback, circuit breakers, cost accounting. Acceptance: inject a deliberately broken schema mid-run → loop detects via L4 → auto-rolls back → run continues.

**Phase 4 — Control surface.** API routes (`/api/agent/run`, `/api/agent/run/[id]` with SSE reusing the `fix-all` pattern) + a dashboard reusing `/site/[id]`: live progress, per-page gate results, pause/resume/kill, dry-run toggle, diff preview.

**Phase 5 — Hardening.** Concurrency caps, idempotent resume, LLM response caching + sitemap filtering (already in `TODOS.md`), per-shop rate-limit handling, optional L6 soft judge.

**Phase 6 — Token lifecycle & auto re-auth.** *Elevated priority — implement before any Phase 3 live (non-dry-run) run, because the `client_credentials` token expires in ~24h and a single run can outlive it.* Turn the §5 mint-on-demand design into code: `getOfflineToken(shop)` exchanges `client_id`/`client_secret` → token at runtime, caches it with `expires_at`, and re-mints proactively (within a buffer of expiry) or reactively (on a `401`). `shopifyFetch` invalidates the cache and retries **once** on a `401`. See `docs/agent/phase-6-token-refresh.md`. Acceptance: with a deliberately-expired cache, a call auto-mints and succeeds with no manual token paste; a mid-run `401` triggers exactly one re-mint + retry (no loops); the token is never logged. Replaces the Phase 0 env-only stopgap and supersedes §8's "encrypted offline token" storage.

A focused engineer gets Phases 0–2 working in dry-run within roughly a week; Phase 3 is what earns the right to flip off dry-run, and Phase 6 must land before Phase 3 runs live so a long run can't die on token expiry. Phases 0 and 1 are complete and verified live against the dev store (read/write/rollback + snippet install round-trip).

---

## 10. Driving the build with Claude Code

Your repo already has `/plan-eng-review`, `/review`, `/ship`, `/browse`. Suggested rhythm per phase:

1. Paste the relevant phase section as the task brief.
2. Run `/plan-eng-review` on the proposed approach **before** coding — especially for Phase 0 (token security, SSRF on fetches — you already have `url-validator/ssrf.test.ts`, extend that posture to Shopify) and Phase 3 (rollback correctness).
3. Implement behind tests. Mirror the existing `__tests__` layout; the validation/crawl modules are already well-covered — match that bar. Mock the Asset API; add one integration test against a dev store gated behind an env flag (like `llm-connectivity.integration.test.ts`).
4. `/review` then `/ship`.

Test priorities, highest first: marker-block idempotency, rollback restores byte-identical asset, L4 catches a non-rendering snippet, planner never re-touches a committed page, circuit breaker halts on budget.

---

## 11. Risks specific to your choices

- **Live theme edits + auto-apply is the sharp edge.** The staging-theme-then-publish workflow (7.2) is the mitigation that lets you keep both choices. If you ever can't stage, fall back to dry-run, not to blind live writes.
- **Liquid rendering ≠ JSON validity.** A schema that validates as JSON can still render wrong inside Liquid (escaping, missing handle, template mismatch). L4 live verify is non-negotiable for that reason.
- **Theme updates / merchant edits clobber your block.** Re-assert the marker block at the start of every run; treat the snippet as managed state you reconcile, not write-once.
- **Asset API rate limits** on large stores. Honor the concurrency caps; back off on 429s.
- **Token & scope security.** Encrypt offline tokens at rest; request the minimum scopes above; never log them.

---

## 12. One-paragraph summary

Build a thin deterministic orchestrator in-repo (`lib/agent/`) that drives perceive → plan → act → verify → commit, reusing SchemaGen's crawl, refinement, and validation engine. The LLM only generates candidate JSON-LD; every gate is deterministic code. Write back to Shopify by injecting a single `{% render 'schemagen-jsonld' %}` include between idempotent markers in `theme.liquid`, with the schema logic isolated in a snippet. Make auto-apply safe by staging on an unpublished theme, verifying the *rendered* page (L4) before publishing, and auto-rolling-back on any gate failure, all under cost/iteration circuit breakers and a full audit trail. Ship Phase 0 (safe read/write/rollback on a dev store) before anything else.
