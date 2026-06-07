/**
 * Deterministic planner (plan §3 step 2). Diffs the perceived per-URL state
 * against the goal and emits an ordered task queue. No model calls.
 *
 *   already-valid   -> skip (never queued)
 *   has schema+errs -> queue "fix"      (cheapest/safest first)
 *   no schema       -> queue "generate" (LLM generation last)
 */
import type { Goal, PerceivedPage, PlannedTask } from "./types";

export interface Plan {
  queue: PlannedTask[];
  skipped: string[];
}

export function planTasks(goal: Goal, perceived: PerceivedPage[]): Plan {
  const queue: PlannedTask[] = [];
  const skipped: string[] = [];

  for (const p of perceived) {
    if (p.satisfied) {
      skipped.push(p.url);
      continue;
    }
    queue.push({
      url: p.url,
      kind: p.hadSchema ? "fix" : "generate",
      beforeErrorCount: p.errorCount,
      beforeHadSchema: p.hadSchema,
    });
  }

  // Cheapest-and-safest first: deterministic fixes before LLM generation.
  // Stable within a kind (preserve perceived order) so runs are reproducible.
  const rank = (k: PlannedTask["kind"]) => (k === "fix" ? 0 : 1);
  queue.sort((a, b) => rank(a.kind) - rank(b.kind));

  const cap = goal.constraints.maxPages;
  return {
    queue: cap != null ? queue.slice(0, cap) : queue,
    skipped,
  };
}
