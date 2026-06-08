/**
 * Agent core types (Phase 2). Declarative goal model (plan §4) + the typed
 * artifacts the planner/executor/audit pass around.
 */
import type { PageStatus } from "@/lib/crawl/types";

export type GoalScope = "all_products" | "all_pages" | "url_list";
export type MinOutcome = "valid" | "rich_results_eligible";

export interface GoalTarget {
  scope: GoalScope;
  /** Required when scope is "url_list". */
  urls?: string[];
  /** Schema types each target page must have, e.g. ["Product"]. */
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
}

export interface Goal {
  id?: string;
  siteId: string;
  target: GoalTarget;
  constraints: GoalConstraints;
  /** Locked to auto_apply per plan §4; Phase 2 always runs dry-run regardless. */
  autonomy: "auto_apply";
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
  /**
   * L6 soft LLM judge (plan §6, Phase 5): "does this schema match the page's intent?".
   * SOFT and informational ONLY — `gatesPassed` deliberately ignores it, so it can never
   * block a commit. null/absent when the judge is disabled (the default) or unavailable.
   */
  L6?: GateResult | null;
}

/**
 * Pre-apply gate verdict (L0–L3). L4 and L6 are deliberately excluded: L4 can only be
 * evaluated AFTER a write (it fetches the live render) and is checked separately in the
 * apply path; L6 is a SOFT LLM judge that only logs and must never block a commit.
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
}

export interface PlannedTask {
  url: string;
  kind: TaskKind;
  beforeErrorCount: number;
  beforeHadSchema: boolean;
}

// ---- Audit ----

export type ActionKind =
  | "generate"
  | "fix"
  | "write"
  | "verify"
  | "rollback"
  | "skip";

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
  /** Audit rows produced by the apply (write / verify / rollback). */
  actions: ActionRecord[];
  /** Set when status="paged": the theme was left dirty (rollback failed). */
  error?: string;
}

// ---- Streaming + cancellation (plan §9, Phase 4) ----

/** Coarse phase of the loop, for progress events. */
export type AgentPhase = "perceive" | "plan" | "act" | "apply" | "done";

/**
 * Cross-request control signal (agent_runs.control). "run" = continue.
 * "kill" halts at the next checkpoint (never mid-apply). "pause" is reserved for
 * Phase 5 durable pause/resume and is treated as "run" by Phase 4's loop.
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
  /** Running counts. */
  perceived?: number;
  queued?: number;
  acted?: number;
  satisfied?: number;
  unsatisfied?: number;
  /** Present on phase "apply" / "done" once the live apply has run. */
  applyStatus?: ApplyStatus;
  /** Human-readable note, e.g. a breaker reason or "killed". */
  message?: string;
}

// ---- Run ----

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
   * Run the SOFT L6 LLM judge per acted page (Phase 5). Default false. When on, the
   * judge's verdict is recorded as gates.L6 but NEVER affects pass/fail — it only logs.
   * Off keeps the path inert (no extra LLM calls), so unit tests stay deterministic.
   */
  judge?: boolean;
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
  actions: ActionRecord[];
}
