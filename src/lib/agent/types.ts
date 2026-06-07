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
}

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

// ---- Run ----

export interface RunOptions {
  /** Phase 2 only supports dry-run; passing false throws (live apply is Phase 3). */
  dryRun?: boolean;
  /** Persist agent_runs/agent_actions to Supabase. Default true. */
  persistAudit?: boolean;
}

export interface RunResult {
  runId: string | null;
  status: "done" | "failed";
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
  actions: ActionRecord[];
}
