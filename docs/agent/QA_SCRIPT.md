# SchemaGen Agent — Dogfood QA Script (drive the next requirements)

**Purpose:** you play the operator (an agency owner onboarding a client's Shopify store) and
drive the agent through its real surface — the dashboard at `/site/<id>/agent` and the
`/api/agent/run` endpoints. This is *exploratory* QA, not a pass/fail test. The job is to
hit friction, write down what's missing, and turn that into the next build. Every scenario
ends with a **📝 Requirement signal** prompt — capture it in the harvest table at the bottom.

This is the post-Phase-5 reality. Phase 5 added concurrency caps, idempotent resume, an LLM
response cache, sitemap filtering, and an opt-in L6 "does this match the page?" judge — but
most of those landed in the **library only**. A big part of this pass is discovering they
have no way in through the UI yet. That gap is the point.

> Companion docs: `docs/agent/E2E_DEMO.md` (customer-facing happy-path walkthrough) and
> `AGENT_IMPLEMENTATION_PLAN.md` §6–§9 (gates, guardrails, phases).

---

## 0. Setup (5 min, once)

1. **Run the app:** `npm run dev` → open http://localhost:3000.
2. **Log in** as yourself (the agent routes require an authenticated Supabase user; an
   unauthenticated `POST /api/agent/run` returns `401`).
3. **Have a site to point at.** The agent runs against a `sites` row you already crawled.
   Run the crawl flow on a Shopify store first, then open **`/site/<id>/agent`** (the "Agent"
   page for that site). You'll see the **Goal** form.
4. **Env sanity** (so live + LLM steps work, not just dry-run):
   - `HEROKU_INFERENCE_URL` / `_KEY` / `_MODEL` — schema generation + the L6 judge.
   - `SHOPIFY_OFFLINE_TOKEN` (or client creds), `SHOPIFY_TEST_THEME_ID` — required for any
     `dryRun: false` (live) run. The agent only ever writes the **test theme**, never published.
5. **Pick a messy store if you can.** A real small Shopify store with admin/collection-dup/
   feed URLs in its sitemap makes Scenario 2 land. A clean store hides the filtering work.

**Two ways to drive:**
- **UI (primary):** the dashboard. This is what a real operator touches — use it first.
- **API (probes):** `curl` against `/api/agent/run`. Needs the Supabase auth cookie. Grab it
  from the browser after logging in (DevTools → Application → Cookies → copy the
  `sb-*-auth-token` cookie) and pass it with `-H "Cookie: <paste>"`. The API cheatsheet is in
  Appendix B.

---

## How to use a scenario

Each block is: **As a user I want… → Do → Expect → Probe → 📝 Requirement signal.**
Run it, then write one line in the harvest table. If something delights you, note that too —
"keep" is a requirement.

---

## S1 — First preview on a real store (the trust moment)

**As a user I want** to see what the agent would change before it touches anything.

**Do:** On `/site/<id>/agent`: Scope = **All products**, Minimum outcome = **Rich-results
eligible**, Required types = `Product`, **Dry run ON**. Click **Start run**.

**Expect:** Phase chip moves `perceive → plan → act → done`. Counts tick
(Perceived / Queued / Acted / Satisfied / Unsatisfied). Per-URL gate chips light up
(L0–L4). Result card shows pages touched/satisfied + a **Diff preview** (the snippet that
*would* be written). Nothing hits the theme.

**Probe:**
- Is it obvious *which* pages were skipped because they were already fine vs newly fixed?
  (`skipped` exists in the payload — is it visible?)
- Does the diff preview tell you what changed *per page*, or just dump one snippet blob?
- How long did it take? Could a non-technical client follow this screen?

**📝 Requirement signal:** clarity of skipped-vs-fixed, per-page diff readability, run timing.

---

## S2 — Messy sitemap (Phase 5 filtering, should be invisible-good)

**As a user I want** the agent to work on real pages, not cart/admin/duplicate junk.

**Do:** Point at a store whose sitemap has noise. Scope = **All pages**. Dry run ON. Start.

**Expect:** Perceived/queued counts reflect **real content pages only**. No `/cart`,
`/account`, `/checkout`, `/policies/*`, `/collections/<x>/products/<y>` duplicates,
`.atom`/`.json` feeds, or `?page=`/`?variant=`/`utm_*` URLs.

**Probe:**
- Count the URLs the run touched vs the raw sitemap size. Did filtering remove the right
  things, or did it eat legitimate pages?
- A store with **no sitemap** → the run finds nothing. What does the user see? (Today: an
  empty, successful-looking run — confusing.)
- Filtering runs *after* the 100-URL cap, so a junk-heavy store can yield <100 good pages
  silently. Did you notice? Should the UI say "filtered N junk URLs"?

**📝 Requirement signal:** no-sitemap empty-state UX, "filtered N URLs" transparency,
over/under-filtering on your real store.

---

## S3 — Re-run the same goal (Phase 5 cache — is the win visible?)

**As a user I want** a second run on an unchanged store to be fast/cheap, and to know it was.

**Do:** Immediately run S1 again, same goal, same store, dry run.

**Expect (library):** the LLM generation cache (24h, keyed on page content) means unchanged
pages don't re-call the model — the second run should be noticeably faster.

**Probe — this is where it breaks down for the user:**
- There is **no cost or cache indicator** anywhere in the UI. You can't see that the second
  run was cheaper or that anything cached. Did it even feel faster?
- The cache is **in-process memory**. On a serverless deploy (Vercel) the second request may
  land on a cold lambda with an empty cache → no hit in production. Does that match what you
  see locally vs deployed?

**📝 Requirement signal:** surface cache hits + per-run cost/time; decide whether the cache
needs to be shared (Redis/Supabase) to survive serverless, or it's effectively local-only.

---

## S4 — Bigger store / tune the throughput (Phase 5 concurrency)

**As a user I want** large stores to finish in reasonable time, and ideally to control the pace.

**Do:** Run All-products against a store with 30–100 products. Watch the `act` phase tick.

**Expect (library):** pages are processed in batches of up to 4 concurrently (was strictly
sequential before Phase 5), so it's faster than one-at-a-time.

**Probe:**
- There is **no concurrency control** in the goal form or the API body — it's hard-wired to
  the default. A user who's getting rate-limited (or wants to go slower/cheaper) can't change it.
- No per-run **page budget** (`maxPages`) or **spend cap** (`maxCostUsd`) field either, even
  though the Goal model supports them. How would a client cap a run at "50 pages, $5"?
- Does the progress screen feel alive during a long run, or does it look stuck between ticks?

**📝 Requirement signal:** expose concurrency + maxPages + maxCostUsd in the form/API;
long-run progress liveliness.

---

## S5 — Kill mid-run, then resume (Phase 5 idempotent resume)

**As a user I want** to stop a run and later pick up where it left off without redoing work.

**Do:**
1. Start a **live** run (Dry run OFF) on a multi-page store. While it's in `act`/`apply`,
   click **Kill**. Confirm status → `killed`, and the theme is not half-written.
2. Now try to **resume** it.

**Expect → the wall:**
- The **Pause** and **Resume** buttons are **disabled** ("Coming in Phase 5"). The control
  API returns **501** for `pause`/`resume` — only `kill` is wired.
- Clicking **Start run** again creates a **brand-new run** (new runId). The Phase 5 resume
  logic (`loadCommittedUrls`) keys off the *same* runId's committed pages — so a fresh Start
  never resumes. **The resume capability exists in code but has no trigger path in the product.**

**Probe:**
- After a kill, what would a real operator expect the Resume button to do — continue the same
  run, or just re-run and skip already-done pages? Both need a runId-reuse path that doesn't
  exist yet (no "re-invoke runGoal with this runId" endpoint).
- Confirm the underlying behavior is at least correct: `GET /api/agent/run/<id>` shows the
  committed (`l4_pass`) actions. A future resume must skip exactly those.

**📝 Requirement signal:** wire Resume — an endpoint that re-runs an existing runId so
`loadCommittedUrls` skips committed pages; enable the button; define the resume UX.

---

## S6 — Turn on the AI sanity-check (Phase 5 L6 judge)

**As a user I want** an extra "does this schema actually match the page?" opinion, logged but
never blocking a good fix.

**Do:** Look for a way to enable the judge in the goal form. Run a goal and look for the L6
verdict per page.

**Expect → the wall:**
- There is **no toggle** for the judge. The API body doesn't accept `judge`, and the route
  doesn't pass it to `runGoal`, so it's off and unreachable in the product.
- Even if it ran, the dashboard gate row renders **L0, L1, L2, L3, L4 — not L6**. The judge's
  verdict would be invisible.

**Probe:**
- Where should the L6 verdict show — a soft chip next to the hard gates? A "review queue" of
  pages the judge flagged but that passed deterministically?
- It's soft by design (never blocks). Make sure the UX communicates "advisory, not a gate."

**📝 Requirement signal:** expose a judge toggle (form + API), render an L6 advisory chip,
decide where flagged-but-passed pages surface.

---

## S7 — Go live + the safety net (rollback)

**As a user I want** to approve real changes and trust they're verified and reversible.

**Do:** With a clean dry-run from S1, flip **Dry run OFF** and Start. Then run the safety demo:
have your operator stage a deliberately broken schema and watch L4 catch it on the live render
and auto-roll-back (see `docs/agent/E2E_DEMO.md` Step 6 for the scripted version).

**Expect:** Apply status `applied` (or `rolled_back` on the safety demo). Re-run Google's Rich
Results Test on a product URL → flips to eligible. After a rollback, the storefront is
byte-identical to before.

**Probe:**
- The result card shows `apply status` + `L4 passed N/M`. Is that enough for a client to trust
  it, or do they want a link to the live page / a before-after?
- Was there any moment you weren't sure whether the live theme was touched?

**📝 Requirement signal:** post-apply proof (live link, RRT deep-link, before/after), live-vs-
test-theme clarity.

---

## S8 — Abuse / edge cases (break it on purpose)

Run these fast; each is a one-line requirement if it misbehaves.

- **Empty required types / bad scope** via API → expect a clean `400`, not a 500. (UI prevents
  this; API is the real boundary.)
- **`siteId` you don't own** → expect `404` (ownership check). Confirm you can't drive another
  user's site.
- **Goal with `maxCostUsd: 0`** (via API) → does the cost breaker trip immediately, or is it
  ignored because production `costUsd` is still hard-coded `0`? (It's the latter — cost
  accounting is a standing TODO. Confirm the breaker is a no-op today.)
- **Kill before perceive finishes** (mash Kill right after Start) → status `killed`,
  `pagesTouched: 0`, nothing written.
- **Navigate away mid-run** → the stream's `cancel` hook should write `kill`; the run stops
  server-side (no dangling run). Verify via `GET /api/agent/run/<id>`.

**📝 Requirement signal:** any 500s, any way to touch another user's site, breaker no-op
visibility, dangling runs.

---

## S9 — The client conversation (zoom out)

After running S1–S8, answer as the agency owner pitching this to a client:
- Could I run this in front of a client without apologizing for anything? Where did I wince?
- What's the one thing that would make a merchant say "yes, do it to all my stores"?
- What's the scariest moment, and is the safety net visible enough to cover it?

**📝 Requirement signal:** the top 1–2 things blocking "I'd let this run on a client's live store."

---

## Requirements harvest (fill as you go)

| # | Scenario | What you saw | Gap / friction | Requirement | Priority |
|---|----------|--------------|----------------|-------------|----------|
| 1 | S1 |  |  |  |  |
| 2 | S2 |  |  |  |  |
| 3 | S3 |  |  |  |  |
| 4 | S4 |  |  |  |  |
| 5 | S5 |  |  |  |  |
| 6 | S6 |  |  |  |  |
| 7 | S7 |  |  |  |  |
| 8 | S8 |  |  |  |  |

---

## Appendix A — gaps I already spotted reading the code (confirm + prioritize)

These fell out of the Phase 5 merge. You'll hit them in the scenarios above; listed here so
you can confirm fast and rank them rather than rediscover from scratch.

1. **Resume is built but unreachable.** `loadCommittedUrls` + the `resume` option work, but
   the UI always Starts a fresh runId and there's no "resume run X" endpoint. Phase 5's
   headline feature has no product trigger. (S5)
2. **Pause/Resume still 501 + buttons disabled.** The control route only wires `kill`; the
   dashboard buttons say "Coming in Phase 5." (S5)
3. **L6 judge has no on-switch and no display.** API body and route don't pass `judge`; the
   gate row renders L0–L4, not L6. (S6)
4. **No concurrency / maxPages / maxCostUsd controls.** The Goal model supports them; the form
   and API body expose none. (S4)
5. **Cache + cost are invisible, and the cache is process-local.** No cache-hit/cost/time in
   the UI; in-memory cache likely won't survive serverless cold starts. (S3)
6. **Cost breaker is a no-op in production.** `costUsd` is hard-coded `0`, so `maxCostUsd`
   never trips on a live run — standing TODO. (S8)
7. **No-sitemap / fully-filtered store = silent empty success.** Confusing empty-state. (S2)

A clean next phase ("Phase 7: control-surface parity") is basically items 1–5: thread the
Phase 5 options through the API + dashboard, add an L6 chip, add a resume endpoint, and
surface cost/cache. That's the requirement set this script is designed to confirm.

---

## Appendix B — API cheatsheet

Start a dry run (needs the auth cookie from your logged-in browser session):

```bash
curl -N http://localhost:3000/api/agent/run \
  -H "Content-Type: application/json" \
  -H "Cookie: sb-<project>-auth-token=<paste-from-devtools>" \
  -d '{
    "siteId": "<your-site-uuid>",
    "dryRun": true,
    "target": { "scope": "all_products", "requireTypes": ["Product"], "minOutcome": "rich_results_eligible" },
    "constraints": { "maxPages": 50, "maxCostUsd": 5, "allowSchemaTypeChange": false }
  }'
```

Inspect a run + its actions (the resume/commit evidence):

```bash
curl http://localhost:3000/api/agent/run/<runId> -H "Cookie: <same-cookie>"
```

Kill a run:

```bash
curl http://localhost:3000/api/agent/run/<runId> \
  -H "Content-Type: application/json" -H "Cookie: <same-cookie>" \
  -d '{"control":"kill"}'
```

Notes:
- `dryRun` defaults to **true**; only an explicit `"dryRun": false` writes the theme.
- `constraints.maxPages` / `maxCostUsd` are accepted by the Goal model but **maxCostUsd is a
  no-op today** (see Appendix A.6).
- There is **no** `concurrency`, `judge`, or `resume` field accepted by the API yet — that
  absence is the requirement, not a typo.
```
