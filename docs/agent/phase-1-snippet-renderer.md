# Phase 1 — Snippet renderer

Source of truth: `AGENT_IMPLEMENTATION_PLAN.md` §5. Definition of done: `npm run verify` green **and** the acceptance criteria below pass.

---

## Goal

Map `page_schemas` → a managed Liquid snippet, and inject a single include into `theme.liquid` idempotently and removably.

## Scope (from plan §5)

1. Render per-template JSON-LD to a managed snippet: `snippets/schemagen-jsonld.liquid`. Page logic lives **here** (`{% if template contains 'product' %}…{% endif %}`), keyed by product handle / template so each page emits the right schema.
2. Include it **once** in `theme.liquid` inside delimited markers:
   ```liquid
   <!-- SCHEMAGEN:START -->{% render 'schemagen-jsonld' %}<!-- SCHEMAGEN:END -->
   ```
3. On every write: GET `theme.liquid`, **replace only the marker block** (insert if absent, replace in place otherwise — never blind-append), PUT back. Removal = delete the marker block + the snippet.

**Why a snippet, not inline:** `theme.liquid` stays a one-line diff forever; all churn is isolated to a file SchemaGen owns; uninstall is clean; avoids corrupting hand-edited theme code.

## Process

1. Implement the renderer + idempotent marker-block insertion.
2. Run `npm run verify` and fix until green.

## Acceptance criteria

- Re-running the writer produces a **byte-identical** `theme.liquid` (idempotency test).
- Removing the block leaves the original `theme.liquid` intact.
- A product fixture renders correct JSON-LD.
