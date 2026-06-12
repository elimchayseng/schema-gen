# Phase 4 — Control surface

Source of truth: `AGENT_IMPLEMENTATION_PLAN.md` §9 (Phase 4). Definition of done: `npm run verify` green **and** the acceptance criteria below pass.

---

## Goal

API routes + a dashboard to start, observe, and control agent runs.

## Scope (from plan §9)

- **API routes:** `/api/agent/run` and `/api/agent/run/[id]` with **SSE**, reusing the existing `fix-all/route.ts` streaming pattern.
- **Dashboard** reusing `/site/[id]` patterns:
  - live progress
  - per-page gate results
  - pause / resume / kill
  - dry-run toggle
  - diff preview

## Process

1. Implement the routes + dashboard, reusing existing streaming and `/site/[id]` patterns.
2. Run `npm run verify` and fix until green.

## Acceptance criteria

- Starting a run streams progress.
- Kill halts mid-run and leaves **no half-written theme**.
- Dry-run toggle is honored end to end.
