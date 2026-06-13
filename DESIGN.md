# SchemaGen — Design System

The single source of truth for SchemaGen's visual language. Before this file,
every `/plan-design-review` and `/design-review` re-derived the system by reading
Tailwind classes off components (issue #16). This document is now the calibration
target; the in-code tokens in `src/app/globals.css` are the implementation of it.

> **If a token and this doc disagree, the token wins and this doc is stale — fix
> the doc.** Tokens are defined once in `src/app/globals.css` under `@theme`
> (Tailwind v4). Never hardcode a hex value in a component; use the token class.

---

## 1. Principles

1. **Deterministic trust, visible.** SchemaGen's product promise is that a
   deterministic validator — not an LLM — judges schema. The UI must look
   precise and accountable, never "magic." Status is always backed by a concrete
   reason the merchant can read.
2. **Calm dark surface, semantic color earns attention.** The canvas is a warm
   near-black; color is reserved for meaning (valid / fixing / error / warning).
   A screen with nothing wrong is mostly monochrome.
3. **One recipe per job.** A given role (primary action, fix action, gate chip)
   has exactly one styling recipe. Divergence is a bug, not a variant.

---

## 2. Color tokens

All colors live in `src/app/globals.css`. Use the Tailwind class form
(`bg-surface-1`, `text-text-secondary`, `border-border`, `bg-fix`, etc.).

### Surface scale (warm zinc, not pure black)
| Token | Hex | Use |
|---|---|---|
| `surface-0` | `#09090b` | App canvas / page background |
| `surface-1` | `#141416` | Raised panels |
| `surface-2` | `#1c1c20` | Cards, list rows |
| `surface-3` | `#27272a` | Hover / active fills, inset wells |
| `surface-card` | `#18181b` | The homepage/agent card motif |

### Borders & text
| Token | Hex | Use |
|---|---|---|
| `border` | `#303036` | Default divider |
| `border-bright` | `#3f3f46` | Emphasized / focused divider |
| `text-primary` | `#fafafa` | Headings, primary copy |
| `text-secondary` | `#a1a1aa` | Supporting copy, labels |
| `text-muted` | `#52525b` | De-emphasized / metadata |

### Accent — emerald (health, validation, clean schema)
| Token | Hex | Use |
|---|---|---|
| `accent` / `valid` | `#10b981` | "Valid", "already good", success |
| `accent-dim` | `#065f46` | Accent fills behind text |
| `accent-bright` | `#34d399` | Accent hover / emphasis |
| `valid-dim` | `#052e16` | Valid chip background |

### Fix phase — indigo (AI processing, optimization)
| Token | Hex | Use |
|---|---|---|
| `fix` | `#4f46e5` | **All AI/fix/generate actions** — the indigo rule |
| `fix-dim` | `#3730a3` | Fix-button hover (on the `text-white` recipe) |
| `fix-bright` | `#6366f1` | Fix emphasis / hover (on the dim-bg recipe) |

### Semantic
| Token | Hex | Use |
|---|---|---|
| `error` | `#ef4444` | Genuine failures only |
| `error-dim` | `#450a0a` | Error chip background |
| `warn` | `#f59e0b` | **Warnings only** — see the amber rule |
| `warn-dim` | `#451a03` | Warning chip background |

---

## 3. Design rules in force

These are project rules confirmed with the maintainer; a review must enforce them.

- **Indigo for AI/fix.** Anything that invokes the LLM or applies a
  fix/generation uses the `fix` (indigo) family. Emerald is for *outcome*
  (valid/good), indigo is for *operation* (fixing/generating). Never use emerald
  for a fix button or indigo for a "valid" badge.
- **No orange/amber for non-warning states.** Amber (`warn`) is exclusively a
  warning signal. Do not use it for neutral counts, "in progress", info, or
  decoration. A stopped-by-user run is **neutral**, not amber.
- **Banners match the homepage card motif.** Any banner/callout uses the
  `surface-card` + `border` card style. **No gradient blobs**, no bespoke
  banner backgrounds.
- **Status is never decoration.** A colored chip must correspond to a real,
  reason-bearing state (a gate result, a validation outcome) — not vibes.
- **Plain-language merchant vocabulary.** Merchant-facing surfaces never expose
  raw DB enums or internal strings (`killed`, `l4_pass`, `last_step`). Map them
  to the vocabulary `buildVerdict` uses (e.g. `killed` → "Stopped by you",
  neutral styling).

---

## 4. Typography

Defined in `@theme`:

| Token | Stack | Use |
|---|---|---|
| `font-sans` | `"Satoshi", ui-sans-serif, system-ui` | All UI text |
| `font-serif` | Instrument Serif, Georgia | Display / hero headlines |
| `font-mono` | `"JetBrains Mono", ui-monospace` | Code, JSON-LD, URLs, IDs |

**Scale** (Tailwind defaults): `text-xs` (labels/metadata) · `text-sm` (body) ·
`text-base` (default) · `text-lg`/`text-xl` (section headings) ·
`text-2xl`+ (page/hero). **Heading hierarchy must not skip levels** (no
h1→h2→h4); if a card is conditionally absent, the levels below it shift up.

---

## 5. Spacing, radius, motion

- **Spacing**: Tailwind 4px scale. Card padding `p-4`/`p-6`; stack gaps
  `gap-3`/`gap-4`; section rhythm `gap-6`/`gap-8`.
- **Radius**: cards `rounded-xl`/`rounded-2xl`; chips/buttons `rounded-lg`;
  inline badges `rounded-md`.
- **Motion**: subtle and purposeful. Use the defined animations
  (`fade-in-up`, `shimmer` for skeletons, `subtle-glow`, `step-pulse` /
  `step-pulse-fix` for active steps). Every animation **must** be disabled under
  `@media (prefers-reduced-motion: reduce)` (already wired in `globals.css`).

---

## 6. Component vocabulary

- **Card** — `bg-surface-card border border-border rounded-xl`. The base
  container for panels, banners, and report sections.
- **Primary action** — emerald accent for run/confirm/go.
- **Fix action** — indigo (`fix`). **One recipe** (pick and keep it consistent
  across `AgentRunner`, `SchemaTweakPanel`, `AgentHero`): `bg-fix text-white
  hover:bg-fix-dim`. Don't mix `text-white+hover:bg-fix-dim` with
  `text-text-primary+hover:bg-fix-bright` (issue #36).
- **GateChip** — pass uses the `valid` family throughout (background *and*
  text); fail uses `error`. Failure detail must be exposed via `aria-label`,
  not `title=` alone (touch + screen-reader accessible).
- **Status icons** — use the inline-SVG icon system everywhere. **No raw
  emoji** as status glyphs (platform-dependent rendering).
- **Skeleton** — `skeleton-shimmer` for loading.

---

## 7. Accessibility baseline

- Interactive state and gate detail must be reachable by keyboard and screen
  reader (`aria-label` on chips conveying status; not `title`-only).
- Maintain visible focus states.
- Honor `prefers-reduced-motion`.
- Don't encode meaning in color alone — pair every semantic color with text or
  an icon.

---

## 8. Maintaining this doc

When you add or change a token in `src/app/globals.css`, update §2 here in the
same PR. When a `/design-review` or `/plan-design-review` discovers a rule that
isn't written down, add it to §3. This file and the tokens are meant to stay in
lockstep.
