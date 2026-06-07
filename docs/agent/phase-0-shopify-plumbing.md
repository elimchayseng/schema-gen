# Phase 0 — Shopify plumbing (prove read + safe write)

**Highest priority. Do this first. Until it is rock-solid, build nothing else.**

Source of truth: `AGENT_IMPLEMENTATION_PLAN.md` §5, §7. Definition of done: `npm run verify` green **and** the acceptance criteria below pass.

---

## Goal

Prove SchemaGen can read a Shopify theme, write a no-op marker block, verify it, and roll back — all from code, against a **development store** + an **unpublished theme**.

## Scope (from plan §5, §9)

- OAuth install flow; offline access token storage. Scopes: `read_themes`, `write_themes`, `read_products`. Store the **encrypted** token per shop in Supabase. Never log tokens.
- Asset API client in `lib/shopify/` exporting: `themeGet`, `themeDuplicate`, `assetGet`, `assetUpsert`, `themePublish`.
- `theme_backups` table + restore (rollback token). See data model §8.

## Guardrails relevant here (plan §7)

- **Backup before touch** — snapshot current `theme.liquid` (and snippet, if present) asset value into a `theme_backups` row keyed by run.
- Encrypt offline tokens at rest; request minimum scopes; never log them.

## Process

1. First run `/plan-eng-review` on the approach for the Asset API client and offline-token storage — focus on **token security and SSRF** (extend the posture in `lib/url-validator/ssrf.test.ts` to Shopify fetches).
2. Implement `lib/shopify/` with the client functions + backup/restore against `theme_backups`.
3. **Mock the Asset API** in unit tests. Add **one** integration test gated behind `RUN_SHOPIFY_INTEGRATION=1` (skipped otherwise) that reads `theme.liquid` from `SHOPIFY_TEST_THEME_ID`, writes a no-op marker block, verifies, and restores byte-identical.
4. Run `npm run verify` and fix until green. **Do not proceed past this file.**

## Acceptance criteria

- Unit tests cover happy path + 429 backoff + restore-on-failure.
- `npm run verify` is green.
- Integration test passes when `RUN_SHOPIFY_INTEGRATION=1` is set against the dev store.
