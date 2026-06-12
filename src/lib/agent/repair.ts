/**
 * Gate-driven self-repair (the agent's "don't give up on the first invalid pass").
 *
 * The executor used to gate a candidate ONCE and, on failure, record `gate_failed`
 * and move on. That made a single malformed field (a `http://` enum, a `sku` on the
 * wrong object, a third-party `Event` block injected by another app) fatal — the run
 * "crashed" on the first validation miss. This module closes that loop:
 *
 *   1. SANITIZE  — drop candidate blocks the agent isn't responsible for (unknown
 *                  third-party types like Event/SoftwareApplication that some Shopify
 *                  apps inject). The goal is to make the REQUIRED types valid, not to
 *                  babysit every block on the page.
 *   2. AUTO-FIX  — re-run the deterministic fixer (cheap, no model) over what's left.
 *                  Catches enum/protocol/placement issues with zero LLM cost.
 *   3. REPAIR    — for any still-invalid candidate of a known/required type, feed the
 *                  EXACT validation errors back to the LLM and ask for a targeted fix,
 *                  re-fix + re-validate the result under a regression guard, and re-gate.
 *                  Loop until the gates pass or the attempt budget is exhausted.
 *
 * The LLM is never a gate — `runGates`/`gatesPassed` stay deterministic. The model is
 * only a *generator* of better candidates here; every output it produces is re-validated
 * by the same engine before it can be accepted.
 */
import { validateSchema } from "@/lib/validation/engine";
import { fixSchemaWithContext } from "@/lib/validation/fixer";
import { schemaDefinitions } from "@/lib/validation/schema-definitions";
import {
  refineSchema as defaultRefineSchema,
  formatIssuesForRefinement,
} from "@/lib/ai/client";
import type { RefinementOutput } from "@/lib/ai/client";
import { runGates, schemaTypesOf } from "./gates";
import { gatesPassed } from "./types";
import type { GateResults, MinOutcome, TypeRequirement } from "./types";

/** The LLM refinement call, injectable so unit tests stay network-free. */
export type RefineFn = (
  currentSchema: Record<string, unknown>,
  issueList: string,
  url: string
) => Promise<RefinementOutput>;

export interface RepairInput {
  url: string;
  candidates: Record<string, unknown>[];
  requireTypes: string[];
  minOutcome: MinOutcome;
  /** Per-type bars (issue #28); replaces requireTypes/minOutcome when present. */
  requirements?: TypeRequirement[];
  beforeErrorCount: number;
  beforeHadSchema: boolean;
  /** Max LLM repair rounds. 0 disables the model entirely (sanitize + auto-fix only). */
  maxAttempts?: number;
  /** Injectable refine fn (defaults to the real LLM client). */
  refineFn?: RefineFn;
  /** Progress sink for the dashboard ("Repairing… fixing 2 issues"). */
  onAttempt?: (attempt: number, detail: string) => void;
}

export interface RepairResult {
  candidates: Record<string, unknown>[];
  gates: GateResults;
  satisfied: boolean;
  /** Number of LLM repair rounds actually run (0 = passed on sanitize + auto-fix). */
  attempts: number;
  /** Friendly notes the LLM produced for gaps it could not fill from page context. */
  enhancementNotes: string[];
}

const DEFAULT_MAX_ATTEMPTS = 3;

/** Is this candidate something the agent is responsible for grading? */
function isOwnedCandidate(
  candidate: Record<string, unknown>,
  requireTypes: string[]
): boolean {
  const types = schemaTypesOf(candidate);
  if (types.length === 0) return false;
  // Keep it if any of its types is a required type OR a type we know how to validate.
  return types.some((t) => requireTypes.includes(t) || t in schemaDefinitions);
}

/**
 * Drop candidate blocks the agent isn't responsible for: unknown third-party types
 * (e.g. an `Event` block a marketing app injected) that would otherwise fail L1 with
 * "Unknown schema type" even though they have nothing to do with the goal. Required
 * types and any known schema.org type are always kept.
 */
export function sanitizeCandidates(
  candidates: Record<string, unknown>[],
  requireTypes: string[]
): Record<string, unknown>[] {
  const kept = candidates.filter((c) => isOwnedCandidate(c, requireTypes));
  // Never strip the page to nothing if everything looked "unknown" — fall back to the
  // original set so the gates can still report a meaningful reason.
  return kept.length > 0 ? kept : candidates;
}

/**
 * Exactly ONE candidate per primary @type. The pipeline merges the page's
 * EXISTING valid schemas with newly generated ones, so a previously-injected
 * Product plus a regenerated Product would both stage — and the live dup gate
 * (issue #24) would then (rightly) roll the apply back. Deterministic
 * preference per type: valid beats invalid, then fewer errors, then fewer
 * warnings, then the LATER candidate (generated content is appended after
 * carried-over existing schemas, so newest wins ties). Output preserves the
 * original relative order of the winners.
 */
export function dedupeCandidatesByType(
  candidates: Record<string, unknown>[]
): Record<string, unknown>[] {
  const bestByType = new Map<string, number>(); // primary type -> candidate index
  const scored = candidates.map((c) => {
    const v = validateSchema(c);
    return { valid: v.valid, errors: v.summary.errorCount, warnings: v.summary.warningCount };
  });
  const better = (a: number, b: number): boolean => {
    const sa = scored[a];
    const sb = scored[b];
    if (sa.valid !== sb.valid) return sa.valid;
    if (sa.errors !== sb.errors) return sa.errors < sb.errors;
    if (sa.warnings !== sb.warnings) return sa.warnings < sb.warnings;
    return a > b; // newest wins ties
  };
  candidates.forEach((c, i) => {
    const primary = schemaTypesOf(c)[0];
    if (!primary) return;
    const cur = bestByType.get(primary);
    if (cur === undefined || better(i, cur)) bestByType.set(primary, i);
  });
  const keep = new Set(bestByType.values());
  return candidates.filter((c, i) => keep.has(i) || !schemaTypesOf(c)[0]);
}

/** Build the issue list for the LLM. Falls back to raw error text when the */
/** fixer-handled filter would otherwise hide everything. */
function buildIssueList(validation: ReturnType<typeof validateSchema>): string {
  const filtered = formatIssuesForRefinement(
    validation.errors,
    validation.warnings
  );
  if (filtered) return filtered;
  // Everything was "fixer-handled" yet still invalid — surface the raw errors so the
  // model has something concrete to act on rather than an empty brief.
  return validation.errors
    .map((e, i) => `${i + 1}. [ERROR] ${e.code} at "${e.path}": ${e.message}`)
    .join("\n");
}

function countErrors(candidates: Record<string, unknown>[]): number {
  return candidates.reduce((n, c) => n + validateSchema(c).summary.errorCount, 0);
}

function gate(input: RepairInput, candidates: Record<string, unknown>[]): GateResults {
  return runGates({
    candidates,
    requireTypes: input.requireTypes,
    minOutcome: input.minOutcome,
    requirements: input.requirements,
    beforeErrorCount: input.beforeErrorCount,
    beforeHadSchema: input.beforeHadSchema,
  });
}

/**
 * Bring a page's candidate schemas to a gate-passing state, using deterministic fixes
 * first and the LLM only as a fallback generator. Pure w.r.t. its inputs; the only
 * side effect is the optional onAttempt progress callback and the injected refineFn.
 */
export async function repairToGoal(input: RepairInput): Promise<RepairResult> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const refineFn = input.refineFn ?? defaultRefineSchema;
  const enhancementNotes: string[] = [];

  // 1 + 2. Sanitize, then a free deterministic auto-fix pass over what remains.
  // The required NAMES come from the per-type requirements when present.
  const requiredNames =
    input.requirements?.map((r) => r.type) ?? input.requireTypes;
  const candidates = dedupeCandidatesByType(
    sanitizeCandidates(input.candidates, requiredNames).map(
      (c) => fixSchemaWithContext(c, { pageUrl: input.url }).fixed
    )
  );

  let gates = gate(input, candidates);
  if (gatesPassed(gates)) {
    return { candidates, gates, satisfied: true, attempts: 0, enhancementNotes };
  }

  // 3. LLM repair rounds. Each round repairs every still-invalid owned candidate, then
  // re-gates. A round that improves nothing breaks the loop (no thrashing).
  let attempts = 0;
  for (let round = 0; round < maxAttempts; round++) {
    const validations = candidates.map((c) => validateSchema(c));
    const invalidIdx = validations
      .map((v, i) => (v.valid ? -1 : i))
      .filter((i) => i >= 0);
    if (invalidIdx.length === 0) break; // valid but gates still fail (e.g. missing required type)

    input.onAttempt?.(
      round + 1,
      `repairing ${invalidIdx.length} schema${invalidIdx.length === 1 ? "" : "s"}`
    );

    let improvedThisRound = false;
    for (const i of invalidIdx) {
      const before = candidates[i];
      const beforeErrors = validations[i].summary.errorCount;
      const issueList = buildIssueList(validations[i]);
      try {
        const out = await refineFn(before, issueList, input.url);
        const fixed = fixSchemaWithContext(out.refined, { pageUrl: input.url });
        const afterErrors = fixed.validationAfter.summary.errorCount;

        // Regression + identity guards: only accept a strictly-better candidate whose
        // @type is unchanged (never let a repair silently morph Product into something
        // else). On a tie or regression, keep what we had.
        const typeStable =
          JSON.stringify(fixed.fixed["@type"]) ===
          JSON.stringify(before["@type"]);
        if (typeStable && afterErrors < beforeErrors) {
          candidates[i] = fixed.fixed;
          improvedThisRound = true;
        }
        if (out.enhancementNotes.length) enhancementNotes.push(...out.enhancementNotes);
      } catch {
        // A failed refine call is non-fatal — keep the current candidate and try the
        // next one. The loop's no-improvement guard will stop us if nothing helps.
      }
    }

    attempts = round + 1;
    gates = gate(input, candidates);
    if (gatesPassed(gates)) break;
    if (!improvedThisRound) break;
  }

  return {
    candidates,
    gates,
    satisfied: gatesPassed(gates),
    attempts,
    enhancementNotes,
  };
}

export { countErrors };
