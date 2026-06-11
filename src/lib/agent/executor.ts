/**
 * Executor (plan §3 steps 3–4). For one planned task: produce a candidate
 * (this is the ONLY place the LLM runs — inside processPage "optimize", which
 * encapsulates generate + refine), then gate it deterministically and stage a
 * snippet entry. Dry-run: nothing is written to Shopify (that is Phase 3).
 */
import { processPage } from "@/lib/crawl/process-page";
import { urlToTemplateTarget, type SnippetEntry } from "@/lib/shopify/snippet";
import { gatesPassed } from "./types";
import { repairToGoal, type RefineFn } from "./repair";
import { runGates } from "./gates";
import { applyOverrides, loadOverrides } from "./overrides";
import { uniformRequirements } from "./page-type-matrix";
import type { ActionRecord, Goal, PlannedTask, TypeRequirement } from "./types";

export interface ExecutedTask {
  url: string;
  satisfied: boolean;
  action: ActionRecord;
  /** Snippet entry to stage, when gates pass and the URL maps to a template. */
  entry: SnippetEntry | null;
}

export interface ExecuteOptions {
  /** Max LLM repair rounds when the first pass fails the gates. Default 3; 0 disables. */
  maxRepairAttempts?: number;
  /** Injectable LLM refine fn for the repair loop (tests pass a deterministic stub). */
  refineFn?: RefineFn;
  /** Progress sink: fired while the agent self-corrects a page. */
  onRepairAttempt?: (url: string, attempt: number, detail: string) => void;
  /**
   * Extra fetch headers (e.g. a storefront-password `Cookie`) forwarded to the page
   * fetch inside processPage, so the executor can read a password-gated dev store.
   */
  fetchHeaders?: Record<string, string>;
}

export async function executeTask(
  goal: Goal,
  task: PlannedTask,
  opts: ExecuteOptions = {}
): Promise<ExecutedTask> {
  // This page's required types with their per-type bars (issue #28): the planner
  // threads them from perceive; absent (pre-matrix callers, url_list fixtures)
  // they fall back to the goal's uniform requireTypes @ minOutcome.
  const requirements: TypeRequirement[] =
    task.requirements ??
    uniformRequirements(goal.target.requireTypes, goal.target.minOutcome);

  // optimize = extract -> validate -> fix -> AI generate -> refine. The required
  // type names ride along so generation produces the page type's required SET
  // (e.g. Product + BreadcrumbList), not whatever the model guesses.
  const result = await processPage(task.url, "optimize", undefined, {
    fetchHeaders: opts.fetchHeaders,
    requiredTypes: requirements.map((r) => r.type),
  });
  const initialCandidates = (result.fixedSchemas ?? []) as Record<string, unknown>[];

  // Self-repair loop: sanitize junk types, deterministically auto-fix, then ask the LLM
  // to correct anything still invalid — re-gating after every round. This is what turns
  // "fails on the first invalid pass" into "keeps correcting until the gates pass".
  const repair = await repairToGoal({
    url: task.url,
    candidates: initialCandidates,
    requireTypes: goal.target.requireTypes,
    minOutcome: goal.target.minOutcome,
    requirements,
    beforeErrorCount: task.beforeErrorCount,
    beforeHadSchema: task.beforeHadSchema,
    maxAttempts: opts.maxRepairAttempts,
    refineFn: opts.refineFn,
    onAttempt: opts.onRepairAttempt
      ? (n, d) => opts.onRepairAttempt!(task.url, n, d)
      : undefined,
  });
  let candidates = repair.candidates;
  let gates = repair.gates;

  // Sticky merchant overrides (issue #29): a merchant correction always wins over a
  // regenerate. Applied AFTER the repair loop produced its candidate and BEFORE the
  // verdict, so the gates evaluate the document that would actually ship. Strictly
  // best-effort: a load failure (no DB in tests, network blip) must behave exactly
  // like "no overrides" — it can never fail the task.
  let overridesApplied = 0;
  try {
    const overrides = await loadOverrides(goal.siteId, task.url);
    if (overrides.length > 0) {
      const merged = applyOverrides(candidates, overrides);
      if (merged.applied.length > 0) {
        candidates = merged.result as Record<string, unknown>[];
        overridesApplied = merged.applied.length;
        // Re-gate the overridden document — overrides are merchant data, not a
        // quality gate; lib/validation still disposes.
        gates = runGates({
          candidates,
          requireTypes: goal.target.requireTypes,
          minOutcome: goal.target.minOutcome,
          requirements,
          beforeErrorCount: task.beforeErrorCount,
          beforeHadSchema: task.beforeHadSchema,
        });
      }
    }
  } catch {
    // best-effort by contract: identical to the no-overrides path
  }

  // ok is the deterministic L0–L3 verdict — lib/validation disposes, never an LLM.
  const ok = gatesPassed(gates);

  const target = urlToTemplateTarget(task.url);
  const entry: SnippetEntry | null =
    ok && target
      ? {
          template: target.template,
          handle: target.handle,
          jsonld: candidates.length === 1 ? candidates[0] : candidates,
        }
      : null;

  // Distinguish a clean gate rejection from an upstream processing/AI failure
  // (processPage swallows AI errors and returns errorReason rather than throwing)
  // so the audit row records *why* a page didn't stage. A success that needed the
  // LLM repair loop records how many rounds it took, so the audit shows the agent
  // self-corrected rather than passing on the first try.
  const baseOutcome = ok
    ? repair.attempts > 0
      ? `staged (self-corrected in ${repair.attempts} ${repair.attempts === 1 ? "pass" : "passes"})`
      : "staged"
    : result.errorReason
      ? `processing_failed: ${result.errorReason}`
      : "gate_failed";
  // Surface applied merchant overrides in the audit row (issue #29).
  const outcome =
    overridesApplied > 0 ? `${baseOutcome}, overrides:${overridesApplied}` : baseOutcome;

  const action: ActionRecord = {
    url: task.url,
    action: task.kind === "generate" ? "generate" : "fix",
    schemaBefore: result.originalSchemas,
    schemaAfter: candidates,
    gates,
    outcome,
    writeTarget: null, // dry-run: nothing written live
    costUsd: 0, // cost accounting lands in Phase 3
  };

  return { url: task.url, satisfied: ok, action, entry };
}
