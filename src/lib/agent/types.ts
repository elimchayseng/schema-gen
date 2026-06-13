/**
 * Agent core types (Phase 2). Declarative goal model (plan §4) + the typed
 * artifacts the planner/executor/audit pass around.
 */
import type { PageStatus } from "@/lib/crawl/types";
import type { ExtractedJsonLd } from "@/lib/url-validator/types";

export type GoalScope = "site" | "all_products" | "all_pages" | "url_list";
export type MinOutcome = "valid" | "rich_results_eligible";

/**
 * One schema type a page must carry, with the bar THAT type must clear. Issue #28:
 * rich-results-requirements marks WebSite/CollectionPage/etc. permanently ineligible,
 * so a single global rich bar over a mixed type set would be unsatisfiable — the bar
 * has to travel per type. `outcome: "valid"` types are only ever required to validate;
 * `outcome: "rich_results_eligible"` types are held to the rich bar only when the
 * goal's minOutcome also demands it (see requirementsForPage in page-type-matrix.ts).
 */
export interface TypeRequirement {
  type: string;
  outcome: MinOutcome;
}

export interface GoalTarget {
  scope: GoalScope;
  /** Required when scope is "url_list". */
  urls?: string[];
  /**
   * Schema types each target page must have, e.g. ["Product"]. Ignored for scope
   * "site", where per-page requirements come from the page-type matrix instead.
   */
  requireTypes: string[];
  minOutcome: MinOutcome;
}

export interface GoalConstraints {
  maxPages?: number;
  maxIterations?: number;
  /** Hard budget breaker — reserved; enforced in Phase 3. */
  maxCostUsd?: number;
  /** Gate novel type changes if false — reserved for Phase 3. */
  allowSchemaTypeChange: boolean;
  /**
   * Authoritative override mode (issue #23). When on, a live apply also SUPPRESSES
   * competing theme JSON-LD emissions (any theme asset that emits a type SchemaGen
   * manages on that page type, or an invalid/unparseable block) on the write-target
   * theme, and the post-write verify demands EXACTLY ONE valid block per required
   * type (the duplicate-prevention gate, issue #24). Blocks injected by apps
   * (external) cannot be removed via theme edits and become requiredMerchantActions.
   * Defaults to true for scope "site", false otherwise — so the pre-integration
   * behavior of every non-site goal is unchanged.
   */
  authoritative?: boolean;
}

export interface Goal {
  id?: string;
  siteId: string;
  target: GoalTarget;
  constraints: GoalConstraints;
  /** Locked to auto_apply per plan §4; Phase 2 always runs dry-run regardless. */
  autonomy: "auto_apply";
  /**
   * Mirror of RunOptions.dryRun, persisted with the goal in agent_runs so the
   * run route's concurrency guard can tell live runs from dry runs. RunOptions
   * remains the execution-time source of truth.
   */
  dryRun?: boolean;
}

// ---- Gates (plan §6) ----

export interface GateResult {
  passed: boolean;
  detail?: string;
}

export interface GateResults {
  L0: GateResult;
  L1: GateResult;
  /** null when minOutcome !== "rich_results_eligible" (gate not applicable). */
  L2: GateResult | null;
  L3: GateResult;
  /**
   * L4 live-verify (plan §7, Phase 3): the candidate, once WRITTEN to the theme,
   * actually renders + re-validates from the live storefront. null in dry-run and
   * for staged-but-not-applied pages (the live render doesn't exist yet).
   */
  L4?: GateResult | null;
}

/**
 * Pre-apply gate verdict (L0–L3). L4 is deliberately excluded: it can only be
 * evaluated AFTER a write (it fetches the live render) and is checked separately in
 * the apply path.
 */
export function gatesPassed(g: GateResults): boolean {
  return (
    g.L0.passed &&
    g.L1.passed &&
    (g.L2 === null || g.L2.passed) &&
    g.L3.passed
  );
}

// ---- Planner ----

export type TaskKind = "fix" | "generate";

export interface PerceivedPage {
  url: string;
  status: PageStatus;
  errorCount: number;
  hadSchema: boolean;
  /** Already meets the goal (its live schema is valid for the required types). */
  satisfied: boolean;
  /**
   * This page's required types with their per-type bars (issue #28). Absent means
   * "uniform from the goal" — derived from target.requireTypes + minOutcome — which
   * keeps every pre-matrix caller and fixture working unchanged.
   */
  requirements?: TypeRequirement[];
  /**
   * The raw JSON-LD blocks of the live render, exactly as the perceive scan's
   * extractor saw them (raw text + parse result + position). Carried so
   * authoritative mode (issue #23) can classify each block's ORIGIN via the
   * schema source locator without re-fetching the page. Absent on fetch
   * failures and for pre-#23 fixtures.
   */
  renderedBlocks?: ExtractedJsonLd[] | null;
}

export interface PlannedTask {
  url: string;
  kind: TaskKind;
  beforeErrorCount: number;
  beforeHadSchema: boolean;
  /** Carried verbatim from the perceived page (see PerceivedPage.requirements). */
  requirements?: TypeRequirement[];
}

// ---- Audit ----

export type ActionKind =
  | "generate"
  | "fix"
  | "write"
  | "verify"
  | "rollback"
  | "skip"
  /** Authoritative mode (issue #23): a competing theme emission was reversibly silenced. */
  | "suppress"
  /** Structured "the merchant must do X" record (e.g. app-injected schema we can't remove). */
  | "merchant_action"
  /** Staging mode (issue #26): the staging theme was published (atomic swap). */
  | "publish";

export interface ActionRecord {
  url: string;
  action: ActionKind;
  schemaBefore: unknown;
  schemaAfter: unknown;
  gates: GateResults | null;
  outcome: string;
  writeTarget?: string | null;
  costUsd?: number;
}

// ---- Circuit breakers (plan §7 item 4) ----

export interface BreakerConfig {
  /** Halt after this many consecutive page failures. */
  maxConsecutiveFailures: number;
  /** Halt when accumulated cost exceeds this (USD). See D3: mechanism only in
   * Phase 3 — production costUsd is 0 until token accounting lands in Phase 5. */
  maxCostUsd?: number;
}

export type BreakerReason =
  | "consecutive_failures"
  | "max_cost_exceeded"
  | "rollback_failed";

export interface BreakerState {
  config: BreakerConfig;
  consecutiveFailures: number;
  costUsd: number;
  /** A rollback that itself failed leaves the theme dirty — terminal, pages the user. */
  rollbackFailed: boolean;
}

/** A halt decision: `halted=false` means keep going. */
export interface BreakerVerdict {
  halted: boolean;
  reason?: BreakerReason;
  detail?: string;
}

// ---- Apply (plan §7 items 1–3) ----

export type ApplyStatus = "applied" | "rolled_back" | "paged";

export interface ApplyResult {
  status: ApplyStatus;
  /** The theme the footprint was written to (live theme id, as a string). */
  writeTarget: string | null;
  /** Per-entry L4 verdicts, in entry order. */
  l4: (GateResult | null)[];
  /** Audit rows produced by the apply (write / verify / suppress / rollback). */
  actions: ActionRecord[];
  /** Set when status="paged": the theme was left dirty (rollback failed). */
  error?: string;
  /**
   * Theme asset keys whose competing JSON-LD emissions were suppressed as part of
   * this apply's managed footprint (issue #23). Suppressed assets are backed up and
   * restored byte-identical by the same rollback that covers theme.liquid/snippet.
   * Absent/empty when nothing was suppressed (non-authoritative runs).
   */
  suppressedAssets?: string[];
}

// ---- Streaming + cancellation (plan §9, Phase 4) ----

/**
 * Coarse phase of the loop, for progress events. "stage" (preparing the staging
 * theme duplicate — slow, O(assets) Asset API calls) and "publish" (atomic swap of
 * the verified staging theme to live) only occur under writeTheme mode "staging".
 */
export type AgentPhase =
  | "perceive"
  | "plan"
  | "act"
  | "stage"
  | "apply"
  | "publish"
  | "done";

/**
 * Cross-request control signal (agent_runs.control). "run" = continue.
 * "kill" halts at the next checkpoint (never mid-apply).
 */
export type HaltSignal = "run" | "kill";

/**
 * One progress event emitted by runGoal via RunOptions.onProgress. The control
 * surface forwards these verbatim over SSE; counts let the dashboard render without
 * re-deriving state.
 */
export interface AgentProgressEvent {
  phase: AgentPhase;
  /** The run id, carried on the first event so the client can target the control route. */
  runId?: string | null;
  /** Page in flight (perceive / act / apply). */
  url?: string;
  /** L0–L4 gate results for this page (act / apply). */
  gates?: GateResults | null;
  /**
   * The exact JSON-LD that would be injected for this page (act). Carried on the stream so
   * the dashboard can show a per-product "structured data to be injected" dropdown inline,
   * without a follow-up DB read. A single object or an array of objects.
   */
  schemaAfter?: unknown;
  /**
   * The executor's per-page outcome for this page (act). Distinguishes a clean gate
   * rejection ("gate_failed") from an upstream AI/processing failure
   * ("processing_failed: …") and a staged success ("staged"). Phase 7 surfaces this as
   * the live, visible failure reason so the operator never has to hover a chip.
   */
  outcome?: string;
  /**
   * Total resolved target URLs for this run (issue #15), streamed on the first
   * perceive event BEFORE the scan loop. Lets the UI show "N not yet scanned"
   * and account for every page even when a run is killed mid-perceive — those
   * pages never emit a per-URL perceive event, so without this total the client
   * would silently under-count them.
   */
  targetTotal?: number;
  /** Running counts. */
  perceived?: number;
  queued?: number;
  acted?: number;
  satisfied?: number;
  unsatisfied?: number;
  /** Present on phase "apply" / "done" once the live apply has run. */
  applyStatus?: ApplyStatus;
  /**
   * Merchant-reviewable preview URL of the staging theme
   * (`https://<shop>/?preview_theme_id=<id>`). Carried on "stage" events once the
   * duplicate is ready, so the UI can link it before the apply even finishes.
   */
  previewUrl?: string;
  /** Human-readable note, e.g. a breaker reason, "killed", or a staging/publish status. */
  message?: string;
  /**
   * Uniform step contract: a named checkpoint inside the phase (e.g. "perceive.scan",
   * "apply.write", "publish.swap"). Every step emits status "start" then "ok"/"fail"
   * (with durationMs); "skip" marks a checkpoint deliberately not run. The same event
   * is persisted to agent_runs.last_step, so the CLI (onProgress), the SSE UI, and the
   * replay GET all show one truth about where a run is.
   *
   * RESERVED: the SSE route uses top-level `step: "done"` / `step: "error"` as its
   * terminal-frame discriminator — never name a progress step "done" or "error".
   */
  step?: string;
  status?: "start" | "ok" | "fail" | "skip";
  durationMs?: number;
  /** Short step-scoped detail (an error message, a count, an asset key). */
  detail?: string;
}

// ---- Run ----

/**
 * Where a live (dryRun:false) apply writes (issues #25/#26).
 *
 *   { mode: "env" }      — today's behavior, the default: write to the env-configured
 *                          SHOPIFY_TEST_THEME_ID. Byte-identical to the pre-staging path.
 *   { mode: "staging" }  — duplicate the PUBLISHED theme (prepareStagingTheme — slow,
 *                          O(assets) Asset API calls), write the managed footprint +
 *                          suppressions to the duplicate, L4-verify via its
 *                          preview_theme_id, and, when `publish` is true AND every gate
 *                          is green, themePublish() it (atomic swap). The previously
 *                          published theme is kept as the rollback artifact. On ANY gate
 *                          failure nothing is published — the live store was never
 *                          touched — and the duplicate is deleted best-effort.
 */
export type WriteThemeStrategy =
  | { mode: "env" }
  | { mode: "staging"; publish: boolean };

/**
 * Outcome of post-publish verification (post-publish.ts): the touched pages
 * re-verified at their REAL urls after themePublish, with the freshness proof
 * separating "Shopify's page cache hasn't converged" (stale — publish stands,
 * re-check later) from "the published render is genuinely wrong" (failed — the
 * displaced theme is auto-republished).
 */
export interface PostPublishOutcome {
  status: "verified" | "stale" | "failed";
  /** Per-page verdicts, in apply order. */
  pages: Array<{
    url: string;
    status: "pass" | "stale" | "fail";
    detail?: string;
    attempts: number;
  }>;
  /**
   * Only meaningful when status="failed": true — the displaced theme was
   * republished (clean auto-rollback); false — the republish itself failed and
   * a human must publish the rollback theme by hand (run status "paged").
   */
  rolledBack?: boolean;
}

/** What the staging flow produced (RunResult.staging; null/absent outside staging mode). */
export interface StagingOutcome {
  stagingThemeId: number;
  /** Merchant-reviewable URL (live storefront rendered with the staging theme). */
  previewUrl: string;
  /** The theme that was duplicated (the published theme). */
  sourceThemeId: number;
  /** True once themePublish() swapped the staging theme live. */
  published: boolean;
  /**
   * Set when published: the previously-published theme id — the rollback artifact.
   * Re-publishing this theme undoes the swap entirely.
   */
  rollbackThemeId?: number;
  /** True when a failed run deleted the staging duplicate (best-effort cleanup). */
  deleted?: boolean;
  /** Post-publish verification verdict (only set when the theme was published). */
  postPublish?: PostPublishOutcome;
}

export interface RunOptions {
  /**
   * Dry-run (default true): stage + gate, never write to Shopify. dryRun:false
   * runs the Phase 3 live path (backup → write → L4 → publish/rollback).
   */
  dryRun?: boolean;
  /** Persist agent_runs/agent_actions to Supabase. Default true. */
  persistAudit?: boolean;
  /** Override breaker thresholds (else defaults + goal.constraints.maxCostUsd). */
  breakers?: Partial<BreakerConfig>;
  /**
   * Caller-supplied agent_runs id. When set, runGoal skips its own createRun and
   * audits against this id — the control surface creates the run first so it can poll
   * control immediately. When omitted, runGoal creates the run itself (Phase 2/3 behavior).
   */
  runId?: string;
  /** Progress sink (Phase 4). Best-effort: a throwing callback never aborts the run. */
  onProgress?: (ev: AgentProgressEvent) => void;
  /**
   * Cooperative cancellation (Phase 4). Polled at each checkpoint: after each perceive
   * page, after each executed task, and immediately BEFORE the live apply. Returning
   * "kill" halts the loop before any further write — the apply path itself is never
   * interrupted, so a kill can never leave a half-written theme.
   */
  shouldHalt?: () => HaltSignal | Promise<HaltSignal>;
  /** Secondary kill: fires on client disconnect (the SSE request's signal). */
  signal?: AbortSignal;
  /**
   * Max pages processed concurrently in the perceive + act phases (Phase 5). Bounds the
   * LLM/scan fan-out so a large store can't flood the inference endpoint or the Asset
   * API. Clamped to 1..5; defaults to 4. The apply path is a single atomic write and is
   * unaffected.
   */
  concurrency?: number;
  /**
   * Idempotent resume (Phase 5). Default true: when auditing against an existing runId,
   * pages already committed live (an l4_pass verify row) are dropped from the queue so a
   * resumed run never re-processes them. A fresh run has no such rows, so this is inert.
   */
  resume?: boolean;
  /**
   * Live-apply write target strategy (issues #25/#26). Default { mode: "env" } —
   * the pre-staging SHOPIFY_TEST_THEME_ID behavior. See WriteThemeStrategy.
   */
  writeTheme?: WriteThemeStrategy;
}

export interface RunResult {
  runId: string | null;
  /**
   * done    — goal met (dry-run all-satisfied, or live apply succeeded).
   * failed  — some page unsatisfied, or a breaker halted the run.
   * rolled_back — live apply hit an L4 failure and restored byte-identical.
   * paged   — live apply's rollback itself failed; theme left dirty, needs a human.
   */
  status: "done" | "failed" | "rolled_back" | "paged";
  iterations: number;
  /** Pages the executor acted on (excludes skips). */
  pagesTouched: number;
  /** Met the goal. Superset of `skipped` (already-satisfied) + newly-staged. */
  satisfied: string[];
  unsatisfied: string[];
  /** Already-satisfied pages the planner never queued (subset of `satisfied`). */
  skipped: string[];
  /** The staged snippet that WOULD be written (dry-run); null if nothing staged. */
  stagedSnippet: string | null;
  /** The live apply outcome (Phase 3). null in dry-run or when nothing was staged. */
  apply?: ApplyResult | null;
  /** Why the run halted early, when a circuit breaker tripped. */
  haltedBy?: BreakerReason;
  /**
   * The run was halted by an explicit kill (RunOptions.shouldHalt → "kill" or an
   * aborted signal), not a breaker. The DB status is still "failed"; this lets the UI
   * show "Killed" distinctly. When killed before the apply, no theme write happened.
   */
  killed?: boolean;
  /** Staging-mode outcome (issue #26). null/absent under writeTheme mode "env". */
  staging?: StagingOutcome | null;
  actions: ActionRecord[];
}
