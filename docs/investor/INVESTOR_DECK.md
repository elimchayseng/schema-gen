# SchemaGen — Investor Deck

> A goal-based agent that makes every page on an ecommerce store legible to AI search and Google rich results — and writes the fix back to the live store itself, safely.

*3 slides · focus: the goal-based agent · prepared 2026-06-08*

---

<!-- SLIDE 1 -->

# Slide 1 — The shift: structured data is now the substrate of AI discovery

### The market is moving from "SEO" to "GEO"

For 15 years, schema.org structured data (JSON-LD) drove Google **rich results** — the stars, prices, and availability that lift click-through. That market never went away. But a second, larger one just opened on top of it.

**ChatGPT, Perplexity, Google AI Overviews, and AI shopping agents now read the web and decide which sources to cite and which products to surface.** Clean, complete structured data is the single strongest signal they use to parse, trust, and reference a page. This is **Generative Engine Optimization (GEO)** — making content legible to LLMs, not just crawlers.

> If your structured data is broken or missing, you are invisible to the next generation of discovery — not just Google, but every AI system that reads the web.

### The problem is real, painful, and unsolved at scale

| Reality on ecommerce stores | Consequence |
|---|---|
| Most stores have **broken, incomplete, or missing** JSON-LD | Lost rich results + invisible to AI answers/shopping |
| Fixing it means reading the schema.org spec and hand-debugging JSON-LD | A specialist task most merchants can't do |
| A store has **hundreds of product pages** | A project nobody finishes manually |
| Themes and merchant edits silently **clobber** fixes | One-time fixes decay |

### Why now

- AI-driven referral traffic is compounding monthly; merchants feel the pull but have no lever.
- The work is **mechanical and checkable** — exactly the shape a reliable agent can own end-to-end.
- Existing tools *report* schema problems. **None of them fix every page and write the result back to the live store.** That gap is the company.

**One line:** Discovery is being rebuilt around machine-readable data. Stores can't keep up by hand. We automate the whole loop.

---

<!-- SLIDE 2 -->

# Slide 2 — The product: a goal-based agent, not a linter

Most "AI SEO" tools hand a merchant a report and a to-do list. SchemaGen takes a **declarative goal** and autonomously drives the store to that state — then proves it held.

### You state a goal. The agent reaches it.

```ts
// The merchant's intent, as data:
{
  target: {
    scope: "all_products",
    requireTypes: ["Product"],
    minOutcome: "rich_results_eligible"   // valid → rich-eligible
  },
  constraints: { maxPages: 200, maxCostUsd: 5, allowSchemaTypeChange: false },
  autonomy: "auto_apply"
}
```

### The loop: perceive → plan → act → verify → commit

```
   PERCEIVE        PLAN            ACT             VERIFY           COMMIT
   crawl + scan →  diff current →  generate +   →  deterministic →  publish
   (no LLM)        vs goal,        render Liquid   gates L0–L4      or AUTO-
                   queue cheapest  snippet                          ROLLBACK
        ▲          -&-safest first                                      │
        └──────────────── loop until goal met / budget hit ◀───────────┘
```

### The moat: **the LLM is never a quality gate**

This is the core engineering decision and the reason results are reliable. Structured-data correctness is *checkable in code*, so we split the agent in two:

- **Controller (deterministic TypeScript):** decides what to do, gates every change, commits or rolls back. **No model calls in the decision path.**
- **Generator (LLM):** proposes candidate JSON-LD from page content. The model proposes; the controller disposes.

Every change clears a stack of **deterministic gates** before it can touch a store:

| Gate | What it proves | Hard? |
|---|---|---|
| **L0** | JSON parses | hard |
| **L1** | schema.org valid (required props, enums, `@context`) | hard |
| **L2** | Google rich-results eligible (offers/price/availability…) | hard* |
| **L3** | **Regression guard** — never ship something worse than what's live | hard |
| **L4** | **Post-write live verify** — re-fetch the rendered page, confirm the JSON-LD actually appears and still validates | hard → triggers rollback |

\* when the goal's `minOutcome` is `rich_results_eligible`. L1–L4 are pure code.

### What makes auto-apply to a *live store* safe

Writing to a merchant's live theme is the sharp edge. Four guardrails — all built — make it boring:

1. **Backup before touch** — snapshot the theme asset; that snapshot is the rollback token.
2. **Stage, don't gamble** — write to an unpublished test theme, verify the *rendered* page (L4) via Shopify's preview, publish only after it passes. The live storefront never sees an unverified state.
3. **Auto-rollback** — any gate failure restores the previous bytes *exactly* and logs it.
4. **Circuit breakers** — halt on N consecutive failures, on cost budget, or if a rollback itself fails (page a human). Never thrash.

Footprint is **one line + one file**: a single `{% render 'schemagen-jsonld' %}` between idempotent markers. Clean install, clean uninstall, no corrupted hand-edited theme code.

### Built today (Phases 0–3 shipped & verified on a live Shopify dev store)

- ✅ Safe Shopify read/write/rollback (Asset API, byte-identical restore)
- ✅ Idempotent snippet renderer + marker injection
- ✅ Deterministic planner + executor + gates **L0–L3** with full audit trail (`agent_runs` / `agent_actions`)
- ✅ Live apply: backup → write → **L4 live verify** → auto-rollback, under circuit breakers
- ✅ Mint-on-demand Shopify token lifecycle (auto re-auth on expiry/401)
- 🔜 Phase 4 control surface (one-click dashboard), Phase 5 cost accounting, Phase 6 multi-merchant install

**One line:** We turned an open-ended "make my store AI-ready" wish into a deterministic state machine that an LLM can power but can never break.

---

<!-- SLIDE 3 -->

# Slide 3 — Why it wins, and the ask

### The defensibility is the boring part — and that's the point

Anyone can call an LLM to draft JSON-LD. Almost no one will do the unglamorous work that makes it *trustworthy enough to auto-apply to a merchant's live revenue page*:

- A **deterministic validation engine** for 30+ schema types, an auto-fixer, and a regression guard — years of edge cases encoded, reused as the agent's gates.
- A **safe live-write protocol** (stage → verify rendered output → rollback) that survives Shopify's eventually-consistent Asset API, theme edits, and Liquid-vs-JSON mismatches.
- A **full audit trail** — every action records before/after schema, gate results, cost, and outcome. This is the debugging, the undo, and the trust story for merchants and partners.

The wedge — Shopify Product schema — is narrow on purpose. The same loop generalizes to every schema type, every platform with a theme/template API, and eventually any "keep my site's machine-readable data correct" goal.

### Where this goes (roadmap → moat compounds)

| Horizon | Capability | Why it matters |
|---|---|---|
| **Now** | Goal-based agent, dry-run + safe live apply on Shopify | Proves the loop end-to-end |
| **Next** | One-click dashboard (Phase 4), real cost metering (Phase 5) | Self-serve, predictable spend |
| **Then** | Multi-merchant OAuth install (Phase 6), continuous re-assertion | Recurring revenue, set-and-forget |
| **Later** | Beyond Product/Shopify → all schema types, WooCommerce, headless, custom sites | TAM expansion on the same engine |

### Business model

- **Per-store subscription** scaling with page count — the agent runs continuously, re-asserting state as themes and catalogs change. The "decay" problem becomes recurring value.
- **Usage-metered LLM cost** passed through transparently (cost accounting lands in Phase 5; the breaker that enforces a merchant's budget is already wired).
- Distribution via the **Shopify App Store** (Phase 6 OAuth install is the unlock), then platform expansion.

### Why this team / why this approach

We made the one decision most AI products get wrong: **we kept the model out of the control loop.** That is what lets us auto-apply to live stores without breaking them — the thing every competitor is too scared (or too unprincipled) to ship. The reliability isn't a model upgrade away; it's architecture, and it's already built.

### The ask

> **Raising to take the agent from "verified on a dev store" to "thousands of merchants on autopilot."** Capital funds Phases 4–6 (self-serve dashboard, cost metering, multi-merchant install + Shopify App Store launch), the first cohort of paying stores, and the go-to-market motion that turns one-time schema fixes into continuous, audited, set-and-forget GEO infrastructure.

**One line:** The discovery layer of the web is being rewritten in JSON-LD. We're the agent that keeps every store correct — and we built the safety to do it live.

---

*Appendix / demo: see `docs/agent/E2E_DEMO.md` for the full phase-checkpointed end-to-end walkthrough that proves each claim above on a real Shopify dev store.*
