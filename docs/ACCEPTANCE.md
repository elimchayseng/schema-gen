# Acceptance checklist — verify the agent e2e flow YOURSELF (~10 min)

This is the human-runnable proof that the pipeline works. No Claude session required.
If every "**you should see**" matches, the flow is healthy. If one doesn't, the step
name tells you exactly where it broke.

## The topology (read this once — it explains 90% of past confusion)

There is **one dev store** and **three theme roles**. Every step reads or writes
exactly one of them:

```
SHOPIFY_SHOP (the dev store; Admin API + storefront host)
│
├── PUBLISHED theme            ← what the PLAIN product URL renders
│     • the before-state scan reads this
│     • staging mode duplicates this; publish swaps it
│     • env mode NEVER touches it
│
├── TEST theme                 ← SHOPIFY_TEST_THEME_ID (must be unpublished)
│     • env mode injects the schemagen snippet here
│     • verified at <product-url>?preview_theme_id=<TEST_THEME_ID>
│
└── STAGING duplicates         ← created/reused by staging mode only
      • inject + verify via preview_theme_id, then optionally publish (atomic swap)
```

> **THE TRAP:** after a successful env-mode run, the plain product URL is
> **unchanged by design**. Only the `?preview_theme_id=` URL shows the injected
> JSON-LD. If you check the normal URL you will wrongly conclude "it didn't work."

Env vars (all in `.env.local`): `SHOPIFY_SHOP` = which store ·
`SHOPIFY_TEST_THEME_ID` = the only theme env mode writes ·
`SHOPIFY_STOREFRONT_PASSWORD` = gets fetches past the password page ·
`SHOPIFY_OFFLINE_TOKEN` (or APP_KEY/SECRET) = Admin API auth.

---

## Part 1 — CLI smoke (~2 min) — the inner debug loop

```bash
npm run smoke -- --url https://ethan-dev-store-1.myshopify.com/products/selling-plans-ski-wax --dry-run
```

1. **You should see** a `SMOKE TOPOLOGY` banner naming the store, the published
   theme, the test theme (role ≠ main), and the exact VERIFY URL.
2. **You should see** named steps with timings: `env-check`, `theme-safety`,
   `before-snapshot`, then inside runGoal: `perceive.resolve_urls`,
   `perceive.scan`, `plan.queue`, `act.page start` → `act.page ok` with gate
   verdicts `L0✓ L1✓ L2✓ L3✓`.
3. **You should see** the BEFORE and AFTER JSON-LD printed in full, and
   `✓ SMOKE GREEN` at the end (exit code 0).

Now run it live (writes the test theme, then verifies the real render):

```bash
npm run smoke -- --url https://ethan-dev-store-1.myshopify.com/products/selling-plans-ski-wax
```

4. **You should see** `apply.backup` → `apply.write` → `apply.l4 ok` steps, then
   `apply=applied … L4 1/1 passed` and `✓ SMOKE GREEN` (~40s total).
5. Open the **VERIFY AT** URL the script prints (the `?preview_theme_id=` one).
   View source (Cmd-Option-U), search `application/ld+json`.
   **You should see** your product's JSON-LD with the right name and price.
6. Open the Google Rich Results link the script prints.
   **You should see** "Product snippets — eligible" (Google needs a publicly
   reachable URL; on a password-gated dev store this one may not load — that's
   the password, not the schema).

If any step fails: exit code 2 = config problem (fix `.env.local`), exit code
1 = pipeline problem, and the failing step name + detail tell you where.

## Part 2 — Browser flow (~8 min) — what a merchant experiences

```bash
npm run dev    # localhost:3000 (or 3001)
```

Login: `qa-e2e@schemagen.test` / `qa-e2e-password-123`

1. Open your site's dashboard → **Agent** page.
   **You should see** the goal form — and if you've run before, a **"Last run"
   card** with its status, last checkpoint, and a "View the full report" link
   (this card survives reloads; the in-memory result does not need to).
2. Scope: *URL list*, paste 1–2 product URLs, write mode **Test theme (safe
   default)**, click **Preview changes** (dry run).
   **You should see** live counts tick (Found / Queued / Processed / Ready) and
   per-page green gate chips when done (~40s/page).
3. Click **Apply** (still env mode).
   **You should see** apply status `applied` with `n/n live-verified`.
4. Click through to the report.
   **You should see** the verdict headline, per-page gate dots, before/after
   schema, and **no** "Apply the run live: … previewed only" action on a run
   that was applied.
5. Reload the agent page mid-run on a future run.
   **You should see** the "Last run" card with `status=running` and the last
   named checkpoint instead of a blank page (requires migration 013 applied —
   see `docs/agent/pending-migration-013.sql`).

## Part 3 — Spot-check commands

```bash
npx tsx --env-file=.env.local scripts/qa-list-themes.ts    # which theme is published vs test
node --env-file=.env.local scripts/qa-last-run.mjs         # last run's audit rows
npx tsx --env-file=.env.local scripts/verify-live-final.ts # PUBLISHED storefront check (staging_publish runs only)
```

## Definition of done for any agent change

`npm run verify` green **AND** `npm run smoke` exit 0.
