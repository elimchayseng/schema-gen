/**
 * Deterministic quality gates L0–L3 (plan §6). No model calls — this is the
 * controller half of the agent. Pure function over candidate JSON-LD plus the
 * pre-change state; reuses the existing validation engine and rich-results map.
 *
 *   L0  JSON parses / is a non-empty set of objects
 *   L1  schema.org valid AND every required type present and valid
 *   L2  rich-results eligible (only when minOutcome demands it)
 *   L3  regression guard: candidate not worse than the current live schema
 */
import { validateSchema } from "@/lib/validation/engine";
import {
  getRichResultInfo,
  getSeverityContext,
} from "@/lib/validation/rich-results";
import type { ValidationResult } from "@/lib/validation/types";
import type { GateResult, GateResults, MinOutcome } from "./types";

const pass = (detail?: string): GateResult => ({ passed: true, detail });
const fail = (detail: string): GateResult => ({ passed: false, detail });

/**
 * The schema's `@type` as an array. JSON-LD allows `@type` to be a string OR an
 * array, so type-membership must be array-aware (a `["Product","Offer"]` page
 * still satisfies a `Product` requirement).
 */
export function schemaTypesOf(obj: unknown): string[] {
  if (obj === null || typeof obj !== "object") return [];
  const t = (obj as Record<string, unknown>)["@type"];
  if (Array.isArray(t)) return t.map((x) => String(x));
  return t != null ? [String(t)] : [];
}

/** True if any error/warning maps to a rich-results-blocking ("critical") impact. */
export function hasCriticalIssue(v: ValidationResult): boolean {
  return [...v.errors, ...v.warnings].some(
    (i) => getSeverityContext(i.code)?.impact === "critical"
  );
}

export interface GateInput {
  candidates: Record<string, unknown>[];
  requireTypes: string[];
  minOutcome: MinOutcome;
  /** Error count of the page's current (pre-change) schema. */
  beforeErrorCount: number;
  /** Whether the page had any schema before this change. */
  beforeHadSchema: boolean;
}

export function runGates(input: GateInput): GateResults {
  const {
    candidates,
    requireTypes,
    minOutcome,
    beforeErrorCount,
    beforeHadSchema,
  } = input;

  // L0 — candidate is a non-empty, JSON-serializable set of objects.
  let L0: GateResult;
  if (candidates.length === 0) {
    L0 = fail("no candidate schemas produced");
  } else {
    try {
      JSON.parse(JSON.stringify(candidates));
      L0 = pass();
    } catch (e) {
      L0 = fail(`candidate is not JSON-serializable: ${(e as Error).message}`);
    }
  }

  // Validate each candidate once; reused by L1/L2/L3.
  const validations = candidates.map((c) => validateSchema(c));
  const typesOf = (i: number) => schemaTypesOf(candidates[i]);

  // L1 — every candidate valid AND each required type present and valid.
  let L1: GateResult;
  if (!L0.passed) {
    L1 = fail("skipped (L0 failed)");
  } else if (!validations.every((v) => v.valid)) {
    L1 = fail("one or more candidate schemas are invalid");
  } else {
    const missing = requireTypes.find(
      (t) =>
        !candidates.some((_, i) => validations[i].valid && typesOf(i).includes(t))
    );
    L1 = missing ? fail(`no valid '${missing}' schema on the page`) : pass();
  }

  // L2 — rich-results eligibility, only when the goal demands it.
  let L2: GateResult | null = null;
  if (minOutcome === "rich_results_eligible") {
    if (!L1.passed) {
      L2 = fail("skipped (L1 failed)");
    } else {
      const problems: string[] = [];
      for (const t of requireTypes) {
        if (getRichResultInfo(t)?.eligible !== true) {
          problems.push(`${t} is not rich-result eligible`);
          continue;
        }
        candidates.forEach((_, i) => {
          if (!typesOf(i).includes(t)) return;
          if (hasCriticalIssue(validations[i])) {
            problems.push(`${t}: a critical issue blocks rich results`);
          }
        });
      }
      L2 = problems.length ? fail(problems.join("; ")) : pass();
    }
  }

  // L3 — regression guard. Never replace a working schema with a worse one.
  const candidateErrors = validations.reduce(
    (n, v) => n + v.summary.errorCount,
    0
  );
  let L3: GateResult;
  if (!beforeHadSchema) {
    L3 = pass("no prior schema; any valid candidate is an improvement");
  } else if (candidateErrors <= beforeErrorCount) {
    L3 = pass(`errors ${candidateErrors} <= prior ${beforeErrorCount}`);
  } else {
    L3 = fail(
      `candidate has more errors (${candidateErrors}) than current (${beforeErrorCount})`
    );
  }

  return { L0, L1, L2, L3 };
}
