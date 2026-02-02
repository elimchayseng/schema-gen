# SchemaGen — Build Plan

**Source:** PRD v2.1 (Schema_Tool_Requirements_v2.docx)
**Last updated:** February 2026

---

## Summary

Build a schema markup generation and deployment tool for Shopify stores per PRD v2.1. The validation engine is the highest priority and has zero external dependencies — it can be built immediately. Subsequent phases layer on database, auth, UI, AI, and Shopify integration.

**Shopify integration (OAuth, crawling, deployment) is deferred to a future phase.** The MVP focuses on the core schema editing, validation, and management experience. Shopify connection will be added once the core tool is solid. Until then, schema can be authored and validated manually, with JSON-LD available for copy/paste or manual deployment.

---

## Phase 1: Validation Engine (HIGH PRIORITY — no external deps)

The PRD explicitly states this must be built before any further feature development. It's pure TypeScript with no database, API, or UI dependencies.

### Files to create

| File | Purpose |
|------|---------|
| `src/lib/validation/types.ts` | All TypeScript types: ValidationResult, ValidationIssue, ValidationErrorCode, PropertyDefinition, SchemaTypeDefinition, SchemaStatus, severity enums |
| `src/lib/validation/schema-definitions.ts` | Single source of truth mapping all 16+ @types to their valid properties (required/recommended/optional), value types, enums, regex patterns, inheritance, and invalidProperties |
| `src/lib/validation/engine.ts` | Core deterministic validator: `validateSchema(jsonLd)` and `validateSchemaString(jsonString)`. Walks nested objects recursively, resolves type inheritance, returns `{ valid, errors[], warnings[], summary }` |
| `src/lib/validation/integration.ts` | Thin wrappers for each integration point: `canDeploy()`, `validateAIOutput()`, `validateEditorContent()`, `auditCrawledSchema()`, `validateBulk()` |
| `src/lib/validation/index.ts` | Barrel export |
| `src/lib/validation/__tests__/engine.test.ts` | 25+ test cases (PRD requires 20 minimum) covering: valid schemas, missing required props, invalid property placement (color on Offer), unknown types, bad JSON, enum validation, URL/date/pattern validation, nested recursion, and <100ms performance |

### Schema types to define (from PRD Section 8.7)

Product, Offer, Organization, LocalBusiness, FAQPage, Question, Answer, Article, BlogPosting, BreadcrumbList, ListItem, AggregateRating, Review, Rating, PostalAddress, Brand, WebSite, Person (+ Thing as base)

### Key acceptance criteria (PRD Section 8.8)

- `color` on Offer flagged as error with guidance to move to Product
- All missing required properties caught
- Errors (blocking) vs warnings (non-blocking) consistently distinguished
- Nested validation works to 3+ levels deep
- Runs in <100ms for typical product page schema
- 20+ passing test cases

---

## Phase 2: Project Bootstrap & Database Schema

### 2a: Dev tooling

- Install additional deps: vitest, @testing-library/react, zod, uuid
- Add `vitest.config.ts` and test setup file
- Add `test` and `test:run` scripts to package.json
- Update `.env.local.example` with all planned env vars

### 2b: Database schema (SQL migration file)

File: `supabase/migrations/001_initial_schema.sql`

Tables:

- **profiles** — extends Supabase auth.users
- **workspaces** — one per client domain (name, store_url, status, health_score, timestamps). Includes nullable `shopify_credentials` and `shopify_store_url` columns for future Shopify integration — not used in MVP.
- **workspace_members** — role-based access (owner/admin/user per workspace)
- **pages** — pages within a workspace (url, page_type, schema_json, deployed_schema_json, validation cache, status, pending change timestamps). Pages are added manually in MVP; automated crawling via Shopify is a future phase.
- **schema_templates** — global and page-type level schema templates (for inheritance)
- **deployments** — deploy log (schema snapshot, previous schema backup, status). Shopify-specific fields (theme file, injection point) are nullable and unused in MVP.
- **crawl_logs** — crawl history. Table is created but unused until Shopify integration is added.

Includes: RLS policies, indexes, updated_at triggers

### 2c: TypeScript types

File: `src/lib/database.types.ts` — hand-written types mirroring all DB tables

---

## Phase 3: Authentication & Authorization

| File | Purpose |
|------|---------|
| `src/middleware.ts` | Protect all routes except /login and /auth/callback |
| `src/app/login/page.tsx` | Login page (email/password + OAuth) |
| `src/app/auth/callback/route.ts` | Supabase auth callback handler |
| `src/components/AuthProvider.tsx` | React context for auth state |
| `src/lib/auth/hooks.ts` | `useUser()`, `useWorkspaceRole()` hooks |
| `src/lib/auth/guards.ts` | `hasMinimumRole()`, `canDeploy()`, `canManageMembers()` helpers |

---

## Phase 4: Workspace Dashboard

Restructure routes to be workspace-scoped:

```
/dashboard                                    → workspace list
/workspace/[workspaceId]                      → workspace detail (page tree + health)
/workspace/[workspaceId]/editor/[pageId]      → schema editor
/workspace/[workspaceId]/settings             → workspace settings + members
```

Note: In MVP, workspace settings covers name, URL, and team members. Shopify connection settings will be added in the Shopify integration phase.

### Components

- **WorkspaceCard** — name, status icon (red/yellow/green), store URL, page count, error/warning counts, last crawl/deploy, pending changes badge, team member count (per PRD 3.3)
- **HealthScore** — displays (error-free pages / total non-ignored pages) × 100 (per PRD 6.3)
- **StatusIcon** — red/yellow/green/gray dot
- **CreateWorkspaceModal**
- **AddPageModal** — manually add pages to a workspace (URL + page type). Replaces automated crawling in MVP.

### API routes

- `api/workspaces` — list + create
- `api/workspaces/[id]` — get + update + delete
- `api/workspaces/[id]/members` — manage team
- `api/workspaces/[id]/health` — recalculate health score
- `api/workspaces/[id]/pages` — manually add/remove pages

---

## Phase 5: Page Tree & Schema Inheritance

### Inheritance logic (`src/lib/schema/inheritance.ts`)

- 3-level shallow merge: Site Global → Page Type → Individual Page
- Most specific level replaces entire properties (no deep merge)

### Page tree UI

- **PageTree** — collapsible tree: Global → Page Type groups → Individual pages
- **TreeNode** — single node with indent, chevron, status dot, label, pending changes indicator
- Status derived from validation engine results (PRD Section 6)

### API routes

- `api/workspaces/[id]/pages` — list pages with status
- `api/workspaces/[id]/templates` — get/update global and page-type templates

---

## Phase 6: Schema Editor (rebuild)

Replace current placeholder editor with full-featured JSON-LD editor.

**New dependency:** CodeMirror 6
Modular, tree-shakeable, native JSON support. (~200KB vs Monaco's ~4MB)

### Components

- **EditorLayout** — top-level split layout
- **EditorBreadcrumb** — "Workspace → Page Type → Page Name" (PRD 7.1)
- **CodeEditor** — CodeMirror with JSON syntax highlighting, line numbers, real-time validation markers
- **ValidationPanel** — error/warning list, clickable to jump to line
- **DiffView** — current vs last-saved schema side-by-side (PRD 7.1). Changes to "current vs deployed" once Shopify integration is added.
- **EditorToolbar** — save, copy JSON-LD, diff toggle, AI assist. Deploy button added in Shopify phase.
- **PreviewPanel** — formatted JSON-LD + copy-to-clipboard button (users can manually paste into their Shopify theme or GTM until direct deployment is available)

### Hooks

- `useValidation` — debounced (300ms) call to `validateSchemaString()`, returns ValidationResult
- `useAutoSave` — debounced save to Supabase

### API routes

- `api/workspaces/[id]/pages/[pageId]` — get + save page schema (runs validation, caches results)
- `api/workspaces/[id]/pages/[pageId]/validate` — explicit validation endpoint

---

## Phase 7: AI Assistant

**Requires:** Anthropic API key

| File | Purpose |
|------|---------|
| `src/lib/ai/system-prompt.ts` | System prompt scoped strictly to schema.org topics (PRD 7.3 guardrails) |
| `src/lib/ai/client.ts` | Anthropic API client |
| `src/lib/ai/schema-assistant.ts` | Constructs prompt with page context, sends to AI, validates output before returning |
| `src/components/editor/AIAssistantPanel.tsx` | Chat-style panel with Generate / Improve / Explain quick actions |
| `api/ai/generate` | Generate schema from page URL or pasted content |
| `api/ai/improve` | Suggest improvements to existing schema |
| `api/ai/explain` | Explain validation errors in plain language |

**Critical:** All AI output routed through validation engine before display (PRD 7.2, 8.5).

---

## Phase 8: Polish & Testing

- Error boundaries and loading skeletons
- Update Navbar with user dropdown + workspace selector
- Comprehensive test suite (validation, inheritance, auth guards, hooks)
- Toast notification system
- Responsive design pass
- Export functionality: download JSON-LD files per page or per workspace

---

## FUTURE: Shopify Integration

**Deferred until core tool is stable and in active use with clients.**

This phase requires a Shopify Partner app and OAuth credentials. It converts the tool from a manual schema management platform to an automated, connected deployment pipeline.

### What this phase adds

**Connection & Crawling**
- `src/lib/shopify/client.ts` — Admin API client with rate limiting + backoff
- `src/lib/shopify/crawler.ts` — Discovers pages via Admin API (products, collections, blogs, pages), extracts existing JSON-LD from theme Liquid templates
- `api/shopify/auth` + `api/shopify/callback` — OAuth flow
- `api/workspaces/[id]/crawl` — initiate + check status
- Required API scopes: `read_products`, `read_content`, `read_themes`, `write_themes`

**Deployment**
- `src/lib/shopify/deployer.ts` — Inject JSON-LD `<script>` tags into Shopify theme Liquid files
- `api/workspaces/[id]/deploy` — pre-deployment validation gate (calls `canDeploy()`, blocks on errors — PRD 9.2)
- `api/workspaces/[id]/deploy/preview` — preview mode (show code without deploying)
- Backup original theme content before injection
- Log every deployment (timestamp, user, page, schema version)

**UI updates when Shopify is added**
- Workspace settings gets Shopify connection panel
- "Connect Shopify" button on workspace card
- Deploy button added to editor toolbar (disabled when validation errors exist per PRD 9.2)
- DiffView changes from "current vs last-saved" to "current vs deployed on live store"
- Crawl button replaces manual page entry
- Workspace card shows "Last crawl" timestamp from live crawl data

### Prerequisites for this phase
- Shopify Partner account and app created
- OAuth credentials configured
- At least one test store available
- Core validation engine and editor working reliably

---

## What can be built NOW vs. needs external setup

| Can build immediately | Needs external setup |
|---|---|
| Phase 1: Full validation engine + tests | Supabase project (Phases 2b–5) |
| Phase 2a: Dev tooling + vitest config | AI provider API key (Phase 7) |
| Phase 2b: SQL migration file (as a file) | Shopify Partner app (FUTURE phase) |
| Phase 2c: TypeScript DB types | |
| Phase 6 partial: Editor UI with client-side validation | |

---

## Verification

After each phase:

- **Phase 1:** Run `npm test` — all 25+ validation tests pass, <100ms per test
- **Phase 2:** Apply migration to Supabase, verify tables and RLS via Supabase dashboard
- **Phase 3:** Log in, verify protected routes redirect unauthenticated users
- **Phase 4:** Create workspace, manually add pages, verify card displays all required fields from PRD 3.3
- **Phase 5:** Verify page tree renders with correct hierarchy and status colors
- **Phase 6:** Edit JSON-LD in editor, verify real-time validation markers appear inline
- **Phase 7:** Generate schema via AI, verify output is validated before display
- **Phase 8:** `npm run build` succeeds with no errors, `npm test` all green
- **FUTURE (Shopify):** Connect Shopify store, crawl, deploy — verify validation gate blocks invalid schema
