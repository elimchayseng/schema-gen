# Agent Build Runbook — driving Claude Code end to end

Companion to `AGENT_IMPLEMENTATION_PLAN.md`. This is the operational layer: what you set up once, how to make Claude Code loop autonomously *within* a phase until tests are green, and the exact prompts to paste.

## The mental model

Claude Code is reliable when "done" is a command that exits 0, and unreliable when "done" is your judgment. So the whole job is to convert the plan into **executable acceptance criteria** and let it loop: *implement → run gate → read failure → fix → repeat → stop when green.* You review at **phase boundaries**, not line by line. Do not ask it to build all six phases in one prompt — it loses the thread and you lose the ability to catch a wrong turn cheaply.

---

## 0. One-time setup you must do yourself

Claude Code cannot create accounts, click OAuth consent, or provision a store. Do these before Phase 0's integration test can pass (unit tests don't need them):

- [ ] Shopify **Partner account** + a **development store** (free, throwaway data).
- [ ] Create a **custom/partner app**; get API key + secret. Scopes: `read_themes`, `write_themes`, `read_products`.
- [ ] Generate an **offline access token** for the dev store (via OAuth or the app's admin).
- [ ] In the dev store, **duplicate the live theme** once by hand so you have a throwaway to point tests at.
- [ ] Add to `.env.local` (names only — Claude Code fills usage, you fill values):
      `SHOPIFY_APP_KEY`, `SHOPIFY_APP_SECRET`, `SHOPIFY_SHOP`, `SHOPIFY_OFFLINE_TOKEN`, `SHOPIFY_API_VERSION`, `SHOPIFY_TEST_THEME_ID`, `RUN_SHOPIFY_INTEGRATION=0`.
- [ ] Decide a token-encryption approach (at minimum: never commit, encrypt at rest in Supabase). Flag this to `/plan-eng-review` in Phase 0.

Keep `RUN_SHOPIFY_INTEGRATION=0` as the default so the autonomous loop never depends on the network. Flip to `1` yourself when you want the one live test to run.

---

## 1. Scaffold the repo so the loop is self-verifying

Do this first (you or a quick Claude Code task). Without it, "work until built" has nothing to check against.

Add to `package.json` scripts and confirm each exits non-zero on failure:

```json
"typecheck": "tsc --noEmit",
"test": "vitest run",
"test:watch": "vitest",
"verify": "npm run typecheck && npm run lint && npm run test"
```

`npm run verify` is the gate. Every phase ends when `verify` is green. Tell Claude Code that explicitly.

Then create per-phase task files so context survives compaction and you can hand it one at a time:

```
docs/agent/phase-0-shopify-plumbing.md
docs/agent/phase-1-snippet-renderer.md
docs/agent/phase-2-agent-core.md
docs/agent/phase-3-guardrails.md
docs/agent/phase-4-control-surface.md
docs/agent/phase-5-hardening.md
```

Each file = the matching section of the plan + the acceptance criteria below. Paste-and-go.

Add one block to `CLAUDE.md` so every session inherits the rules:

```md
## Agent build rules
- Source of truth: AGENT_IMPLEMENTATION_PLAN.md. Current task: docs/agent/phase-N-*.md.
- Definition of done for a phase: `npm run verify` is green AND acceptance criteria in the phase file pass.
- The LLM is never a quality gate. All schema judgment goes through lib/validation.
- Never call the live Shopify API in unit tests. Mock the Asset API. The single
  integration test is gated behind RUN_SHOPIFY_INTEGRATION=1 and skipped otherwise.
- Work on branch feat/agent. Commit per phase. Do not edit a live/published theme — only SHOPIFY_TEST_THEME_ID or a duplicate.
- After implementing, run `npm run verify` and fix until green before reporting done.
```

---

## 2. The per-phase loop (how it actually grinds)

For each phase, paste the prompt below. The pattern inside one session:

1. `/plan-eng-review` the approach **before** code (especially Phase 0 token security/SSRF, Phase 3 rollback).
2. It writes tests + implementation.
3. It runs `npm run verify`, reads failures, fixes — **looping on its own** until green. This is the "until it builds" part; it lives inside one phase, driven by the test command.
4. `/review`, then `/ship` (commit on `feat/agent`).
5. You sanity-check the acceptance criteria, then start the next phase in a fresh session (clears context).

If a phase is large, tell it to checkpoint-commit after each green sub-step so a bad turn rolls back cheaply.

---

## 3. Copy-paste phase prompts

Each assumes the phase file exists and `CLAUDE.md` has the rules block.

**Phase 0**
> Read AGENT_IMPLEMENTATION_PLAN.md §5 and §7, and docs/agent/phase-0-shopify-plumbing.md. First run /plan-eng-review on your approach for the Shopify Asset API client and offline-token storage — focus on token security and SSRF (extend the posture in lib/url-validator/ssrf.test.ts). Then implement lib/shopify/ with: themeGet, themeDuplicate, assetGet, assetUpsert, themePublish, and backup/restore against theme_backups. Mock the Asset API in unit tests. Add ONE integration test gated behind RUN_SHOPIFY_INTEGRATION=1 that reads theme.liquid from SHOPIFY_TEST_THEME_ID, writes a no-op marker block, verifies, and restores byte-identical. Run npm run verify and fix until green. Do not proceed past this file.
>
> Acceptance: unit tests cover happy path + 429 backoff + restore-on-failure; `npm run verify` green; integration test passes when I flip the flag.

**Phase 1**
> Read docs/agent/phase-1-snippet-renderer.md and AGENT_IMPLEMENTATION_PLAN.md §5. Implement the renderer: page_schemas → snippets/schemagen-jsonld.liquid with per-template/handle conditionals, plus idempotent marker-block insertion (<!-- SCHEMAGEN:START/END -->) into theme.liquid (insert if absent, replace in place otherwise — never blind-append). Run npm run verify and fix until green.
>
> Acceptance: re-running the writer produces a byte-identical theme.liquid (idempotency test); removing the block leaves original theme.liquid intact; a product fixture renders correct JSON-LD.

**Phase 2**
> Read docs/agent/phase-2-agent-core.md and AGENT_IMPLEMENTATION_PLAN.md §3–§6, §8. Build lib/agent/: Goal types, a deterministic planner (diff current page_schemas vs target → ordered queue, skip already-valid), an executor wrapping processPage + refineAndValidate + the Phase 1 renderer, gates L0–L3, and the agent_runs/agent_actions audit writes. No model call in the planner or any gate. Default to dry-run (stage, report diff, never publish). Run npm run verify and fix until green.
>
> Acceptance: runGoal on a 5-page fixture store reaches all-valid in dry-run; planner never queues an already-valid page; every action writes an audit row with gate results.

**Phase 3**
> Read docs/agent/phase-3-guardrails.md and AGENT_IMPLEMENTATION_PLAN.md §7. First /plan-eng-review the rollback + staging-theme correctness. Then add: backup-before-touch, stage-on-duplicate-theme → L4 live-verify (re-fetch rendered preview, re-extract, re-validate) → publish/swap, auto-rollback on any hard-gate failure, and circuit breakers (consecutive failures, maxCostUsd, failed-rollback halt). Run npm run verify and fix until green.
>
> Acceptance: a test that injects a non-rendering snippet proves L4 fails → auto-rollback restores byte-identical → run continues; budget breaker halts the run; rollback-failure pages instead of thrashing.

**Phase 4**
> Read docs/agent/phase-4-control-surface.md. Add /api/agent/run and /api/agent/run/[id] (SSE, reuse the fix-all streaming pattern) and a dashboard reusing /site/[id] patterns: live progress, per-page gate results, pause/resume/kill, dry-run toggle, diff preview. Run npm run verify and fix until green.
>
> Acceptance: starting a run streams progress; kill halts mid-run and leaves no half-written theme; dry-run toggle is honored end to end.

**Phase 5**
> Read docs/agent/phase-5-hardening.md and TODOS.md. Add concurrency caps (3–5) on theme writes, idempotent resume via fix_attempted_at, LLM response caching (24h, content-hash key), sitemap quality filtering, and 429 backoff. Optional L6 soft LLM judge — logged, never gating. Run npm run verify and fix until green.

---

## 4. When it gets stuck

- **Looping on the same failing test:** stop it, read the test yourself — usually the acceptance criterion is wrong or under-specified, not the code. Fix the spec, restart.
- **Wants to call the live store in a unit test:** that's the rules block failing to stick — re-paste it; insist on mocks.
- **Context drift after a long phase:** start a fresh session, point it at the phase file + `git diff`, ask it to continue.
- **Scope creep into later phases:** the "Do not proceed past this file" line in each prompt is what holds the line; re-assert it.

---

## 5. What "end to end with tests" means here

Done = all six phase files complete, `npm run verify` green on `feat/agent`, and the Phase 3 auto-rollback test plus the Phase 0 integration test (flag on) both pass against your dev store. At that point flip dry-run off on the dev store, watch one real run, then decide about production. Do not point it at a production store until you've watched a full auto-apply + verify + (forced) rollback cycle succeed on the dev store.
