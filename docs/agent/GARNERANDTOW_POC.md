# Garnerandtow.com POC — One-Shot Agent Run Results

**Date:** 2026-06-10 · **Branch:** `feat/garnerandtow-poc` · **Run:** `218d53cb` (dry-run)

## The result

> **You're good to go — All 30 pages checked now carry valid structured data
> (20 fixed, 10 newly generated).** 0 failed, 0 not reached. 726s.

One input (the homepage URL), zero hand-picked pages, zero merchant action. The
agent enumerated the entire site from the public sitemap, classified every page,
validated what exists, generated and self-corrected what didn't, and staged a
complete per-page schema set that passed every deterministic gate:

| Page type | Pages | Schema staged |
|---|---|---|
| Homepage | 1 | Organization + WebSite |
| Products | 12 | Product (offers/price/availability/brand/gtin) + BreadcrumbList |
| Collections | 5 | CollectionPage + BreadcrumbList |
| Blog articles | 8 | BlogPosting/Article + BreadcrumbList |
| Pages | 7 | WebPage (incl. AboutPage/ContactPage subtypes) + extras |

Proof artifacts (this directory): `garner-dryrun-report.json` (the merchant
report: per-page before/after, gate verdicts, Google Rich Results deep links)
and `garner-dryrun-snippet.liquid` (the exact code that would be injected).

## Real-world defects the run handled

1. **The broken duffel block** — the live theme emits Product JSON-LD that is
   invalid JSON (unescaped quotes from a Shopify metaobject:
   `"value": "["gid://…"]"`). The extractor's structural repair recovered it,
   surfaced it as an error state (never "schema missing"), and the agent staged
   a complete valid replacement.
2. **The misjudged `@graph`** — the valid `{@context, @graph:[…]}` block was
   previously failed for "missing @context" on every member. Context now
   propagates on flatten; the block validates.
3. **Missing `offers`** — the live Product carried no commerce data; Google
   requires one of offers/review/aggregateRating. The parity-audited validator
   catches it and generation fills it from the page.

## Failure modes found live and fixed (runs 1→4)

| Run | Outcome | Root cause → fix |
|---|---|---|
| 1 | 9/14, breaker halt | Inference endpoint congestion at concurrency 4 → timeouts. Gates correctly refused partial sets. Lowered to 2. |
| 2 | 25/30 | Generated `publisher` Organizations lacked `url` (nested-fix ran before root url autofill — ordering bug); 1 transient bad LLM response. |
| 3 | 24/30 | Ordering fixed but two NEW classes: gates matched required types by name equality (`AboutPage` failed a `WebPage` requirement); the model echoed page copy with unescaped quotes (`The word "garner" means…`) into JSON. |
| 4 | **30/30** | Subtype-aware `typeSatisfies()` in every gate + structural quote-repair on LLM responses. |

Every fix is deterministic, unit-tested (655 tests green), and none loosened a
quality bar: a parent type still never satisfies a more-specific requirement,
and repaired LLM output still passes the zod shape gate and all schema gates.

## What this proves / what remains

**Proven, against the live store:** enumeration → classification → validation
→ generation → self-repair → gates L0–L3 → staged snippet + merchant report,
one-shot, no per-page babysitting.

**Remaining for the full live apply (code complete, needs credentials):**
1. Merchant installs the app on garnerandtow (read/write_themes, read_products)
   and provisions via `/api/agent/provision` — see `MERCHANT_SETUP.md`.
2. Apply Supabase migrations 008–012 (`pending-migrations-008-012.sql`).
3. Run live with `writeTheme: staging`: duplicate published theme → write
   footprint + suppress the competing theme blocks (the broken duffel emitter)
   → L4 verify on preview incl. the exactly-one-block duplicate gate → publish
   (atomic swap; old theme kept as instant rollback) → merchant report with
   "Confirm with Google" links on the live pages.

The two actions the dry-run report lists are exactly right: "apply the run
live" (it was a preview) and the duplicate warning (suppression only executes
on a live apply against the real theme).
