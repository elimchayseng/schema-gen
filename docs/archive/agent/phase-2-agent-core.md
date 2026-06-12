# Phase 2 — Agent core

Source of truth: `AGENT_IMPLEMENTATION_PLAN.md` §3–§6, §8. Definition of done: `npm run verify` green **and** the acceptance criteria below pass.

---

## Goal

Build the deterministic orchestrator `lib/agent/` that drives perceive → plan → act → verify in **dry-run** (stage, report diff, never publish).

## Scope (from plan §3, §4, §6, §8)

- **Goal types** (`lib/agent/types.ts`) — declarative target state + constraints (see plan §4).
- **Deterministic planner** — diff current `page_schemas` vs target → ordered task queue, cheapest-and-safest first (already-valid → skip; auto-fixable → next; needs-generation → last). **No model call in the planner.**
- **Executor** — wraps existing `processPage` + `refineAndValidate` + the Phase 1 renderer. Nothing written live.
- **Gates L0–L3** (plan §6): L0 JSON parses, L1 schema.org valid (`validateSchema` / `canDeploy`), L2 rich-results eligibility, L3 regression guard. **No model call in any gate.**
- **Audit writes** — `agent_runs` / `agent_actions` rows per action with gate results (data model §8).

## Core principle (plan §1)

Keep the LLM out of the control loop. The model only proposes candidate JSON-LD; the controller disposes. Every gate is deterministic.

## Process

1. Implement `lib/agent/` per scope above. Default to **dry-run**.
2. Run `npm run verify` and fix until green.

## Acceptance criteria

- `runGoal` on a 5-page fixture store reaches all-valid in dry-run.
- Planner never queues an already-valid page.
- Every action writes an audit row with gate results.
