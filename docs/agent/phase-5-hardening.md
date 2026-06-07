# Phase 5 — Hardening

Source of truth: `AGENT_IMPLEMENTATION_PLAN.md` §9 (Phase 5), §7, and `TODOS.md`. Definition of done: `npm run verify` green.

---

## Goal

Production-harden the agent: concurrency, resume, caching, filtering, rate limits.

## Scope (from plan §7, §9, and TODOS.md)

- **Concurrency caps (3–5)** on theme writes (Asset API is rate-limited).
- **Idempotent resume** via the `fix_attempted_at` pattern from `page_schemas` — a resumed run never re-processes a committed page.
- **LLM response caching** — 24h, content-hash key.
- **Sitemap quality filtering** (already flagged in `TODOS.md`).
- **429 backoff** per-shop rate-limit handling.
- **Optional L6 soft LLM judge** — "does this match page intent?" — **logged, never gating** (plan §6).

## Process

1. Implement the hardening items above.
2. Run `npm run verify` and fix until green.

## Acceptance criteria

- `npm run verify` is green.
- Resume does not re-process committed pages.
- Concurrency cap is enforced on theme writes; 429s back off.
- L6 judge (if added) only logs — it never blocks a commit.
