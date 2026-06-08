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
}

/**
 * Pre-apply gate verdict (L0–L3). L4 is deliberately excluded: it can only be
 * evaluated AFTER a write (it fetches the live render), so it is checked
 * separately in the apply path, not here.
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
  actions: ActionRecord[];
}
