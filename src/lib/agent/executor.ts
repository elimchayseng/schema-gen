/**
 * Executor (plan §3 steps 3–4). For one planned task: produce a candidate
 * (this is the ONLY place the LLM runs — inside processPage "optimize", which
 * encapsulates generate + refine), then gate it deterministically and stage a
 * snippet entry. Dry-run: nothing is written to Shopify (that is Phase 3).
 */
import { processPage } from "@/lib/crawl/process-page";
import { urlToTemplateTarget, type SnippetEntry } from "@/lib/shopify/snippet";
import { gatesPassed } from "./types";
import { l6Judge } from "./judge";
import { repairToGoal, type RefineFn } from "./repair";
import type { ActionRecord, Goal, PlannedTask } from "./types";

export interface ExecutedTask {
  url: string;
  satisfied: boolean;
  action: ActionRecord;
  /** Snippet entry to stage, when gates pass and the URL maps to a template. */
  entry: SnippetEntry | null;
}

export interface ExecuteOptions {
  /** Run the SOFT L6 judge and attach its verdict as gates.L6 (never gates). Default off. */
  judge?: boolean;
  /** Injectable judge for tests; defaults to l6Judge. */
  judgeFn?: typeof l6Judge;
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
  // optimize = extract -> validate -> fix -> AI generate -> refine.
  const result = await processPage(task.url, "optimize", undefined, {
    fetchHeaders: opts.fetchHeaders,
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
    beforeErrorCount: task.beforeErrorCount,
    beforeHadSchema: task.beforeHadSchema,
    maxAttempts: opts.maxRepairAttempts,
    refineFn: opts.refineFn,
    onAttempt: opts.onRepairAttempt
      ? (n, d) => opts.onRepairAttempt!(task.url, n, d)
      : undefined,
  });
  const candidates = repair.candidates;
  const gates = repair.gates;
  // ok is the deterministic L0–L3 verdict. The L6 judge is computed AFTER this and never
  // feeds into ok — gatesPassed ignores L6 by contract, so it is logged, never gating.
  const ok = gatesPassed(gates);

  if (opts.judge) {
    const judgeFn = opts.judgeFn ?? l6Judge;
    gates.L6 = await judgeFn({ url: task.url, candidates });
  }

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
  const outcome = ok
    ? repair.attempts > 0
      ? `staged (self-corrected in ${repair.attempts} ${repair.attempts === 1 ? "pass" : "passes"})`
      : "staged"
    : result.errorReason
      ? `processing_failed: ${result.errorReason}`
      : "gate_failed";

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
