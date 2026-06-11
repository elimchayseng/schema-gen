# SchemaGen agent — STATUS (single living doc)

> This is the ONE status document. Update it in place; don't create dated
> siblings. History lives in git and `docs/archive/`.
> Last updated: 2026-06-11 (post-retro simplification pass).

## Where things stand

**The e2e pipeline works and is now human-verifiable.** One command proves it:

```bash
npm run smoke -- --url https://ethan-dev-store-1.myshopify.com/products/<handle>
```

~40 seconds: scan → LLM generate → deterministic gates (L0–L3) → merge-write the
snippet to the test theme → L4 live-render verification → preview URL to eyeball.
`docs/ACCEPTANCE.md` is the full ≤10-min human checklist (start there; it also
explains the store/theme topology and the `?preview_theme_id=` trap).

**Definition of done for agent work:** `npm run verify` green AND `npm run smoke` exit 0.

## What changed in the 2026-06-11 simplification pass (retro-driven)

The retro finding: success only existed inside Claude sessions — there was no
verification a human could run, and mid-run the flow was opaque. Fixes:

1. **`npm run smoke`** (`scripts/smoke-e2e.ts`) — the new inner debug loop.
   Topology banner, theme-role safety check (refuses to write a published theme
   — `resolveWriteThemeId` never checked role), named steps with timings,
   before/after JSON-LD, exit codes 0/1/2.
2. **Uniform step contract** — every checkpoint emits `step`/`status`/`durationMs`
   (`perceive.resolve_urls`, `perceive.scan`, `plan.queue`, `act.page`,
   `stage.prepare`, `apply.backup/write/suppress/l4/rollback`, `publish.swap`,
   `publish.post_verify`) through the same progress sink, persisted to
   `agent_runs.last_step` (migration 013 — **pending manual apply**, see
   `docs/agent/pending-migration-013.sql`). CLI, SSE UI, and the replay GET now
   share one truth about where a run is.
3. **Rehydrate on mount** — the agent page shows a "Last run" card (status, last
   checkpoint, report link) after a reload instead of a blank form.
4. **Report copy fixes** — (a) post-publish verify rows no longer shadow the first
   page's `l4_pass` (every published run used to claim its first page was
   "previewed only"); (b) idempotent suppression skips now record
   `already_suppressed:` rows so reused staging themes don't trigger the bogus
   "your theme still emits the original structured data" action.
5. **`priceValidUntil` expiry rule** — past dates are now a deterministic
   validation error (`EXPIRED_PRICE_VALID_UNTIL`) and the fixer bumps them one
   year forward, so the repair loop heals the LLM's habit of emitting last
   year's date without another model call. Proven live on the smoke run.
6. **Dead code removed** — pause/resume control stubs (501 path) and the L6 soft
   LLM judge (computed, never gated, never exposed).
7. **Docs consolidated** — this file + `docs/ACCEPTANCE.md` are the source of
   truth; everything else moved to `docs/archive/`.

## Open items

1. **Apply migration 013** (`docs/agent/pending-migration-013.sql`) in the
   Supabase SQL editor — until then `last_step` is null and the live-checkpoint
   display has nothing to read (everything else works).
2. **Garnerandtow one-shot** — everything rehearsed (30/30 dry-run green);
   blocked only on real-store credentials. Flow: dry-run → staging-only →
   preview → publish → post-publish verified → Google Rich Results links.
   See `docs/GARNERANDTOW_POC.md` and `docs/MERCHANT_SETUP.md`.
3. **Dev-store cache convergence** — `verify-live-final.ts` may FAIL a page for
   hours after a publish while Shopify's page cache converges. Reading the
   verdict: `post_publish:stale` = cache, re-poll later; `post_publish:failed` =
   genuinely wrong render (auto-republish of the displaced theme already
   happened).
4. **Tweak panel** — proven at library level (sticky overrides across
   regeneration); deserves a browser pass (ACCEPTANCE Part 2 can be extended).

## Architecture in one paragraph

`runGoal` (src/lib/agent/run.ts) does perceive → plan → act → live apply.
Write modes: `env` (test theme `SHOPIFY_TEST_THEME_ID`, verified via
`?preview_theme_id=` — the fast path, also what `npm run smoke` uses),
`staging` (duplicate of the published theme, checksum-resync ~14s when reused),
`staging_publish` (+ atomic `themePublish` swap + post-publish verification with
freshness proof; rollback = swap back). Suppression of competing theme JSON-LD
(source-locator) runs only in authoritative mode (defaults on for `scope:"site"`).
All schema judgment is deterministic in `lib/validation` — the LLM is never a
quality gate. Audit: `agent_runs` / `agent_actions` / `theme_backups` in Supabase.

## Dev store facts

- Store: `ethan-dev-store-1.myshopify.com` (password-gated; cookie flow handles it)
- Test theme (env-mode target): `SHOPIFY_TEST_THEME_ID` in `.env.local` —
  `npm run smoke` asserts its role ≠ main before any write
- QA login: `qa-e2e@schemagen.test` / `qa-e2e-password-123`
