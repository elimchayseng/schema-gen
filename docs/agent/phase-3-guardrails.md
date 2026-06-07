# Phase 3 — Guardrails + auto-apply

Source of truth: `AGENT_IMPLEMENTATION_PLAN.md` §7. Definition of done: `npm run verify` green **and** the acceptance criteria below pass.

**This phase earns the right to flip off dry-run.**

---

## Goal

Make auto-apply to a live theme safe via staging + L4 live verify + auto-rollback + circuit breakers.

## Scope (from plan §7, §6)

1. **Backup before touch** — snapshot `theme.liquid` (+ snippet) into `theme_backups` keyed by run.
2. **Stage on an unpublished theme** — duplicate the live theme → write to the copy → **L4 live verify** (re-fetch rendered preview, re-extract, re-validate that the JSON-LD actually appears and validates live) → only then publish/swap. The live storefront never sees an unverified state.
3. **Auto-rollback** — any hard-gate failure (including L4) → restore the backed-up asset value, mark the action `rolled_back`, continue or halt per policy.
4. **Circuit breakers** — halt the whole run if: N consecutive page failures, cost exceeds `maxCostUsd`, or rollback itself fails (page the user). Never thrash.

## Process

1. First run `/plan-eng-review` on **rollback + staging-theme correctness**.
2. Implement the guardrails above.
3. Run `npm run verify` and fix until green.

## Acceptance criteria

- A test that injects a non-rendering snippet proves: L4 fails → auto-rollback restores **byte-identical** → run continues.
- Budget breaker halts the run.
- Rollback-failure **pages** instead of thrashing.
