/**
 * AI Schema Refinement Loop
 *
 * Orchestrates the generate → fix → validate → refine → fix → validate cycle.
 * Ensures users receive schemas that are valid for Google Rich Results,
 * with friendly enhancement notes for any remaining gaps.
 */

import { refineSchema, formatIssuesForRefinement } from "./client";
import { fixAndValidateAIOutputWithContext } from "@/lib/validation/integration";
import type { SchemaRecommendation, ValidatedRecommendation } from "./types";
import type { FixResult } from "@/lib/validation/types";

const MAX_REFINEMENT_PASSES = 1;

export interface RefinementResult {
  schema: Record<string, unknown>;
  fixResult: FixResult;
  enhancementNotes: string[];
  refinementPasses: number;
}

/**
 * Fix, validate, and optionally refine a single AI-generated schema.
 * Returns the best possible result with enhancement notes for unresolved warnings.
 */
export async function refineAndValidate(
  rec: SchemaRecommendation,
  pageUrl: string,
  _html: string,
  maxPasses: number = MAX_REFINEMENT_PASSES
): Promise<RefinementResult> {
  // Initial fix + validate
  let fixResult = fixAndValidateAIOutputWithContext(
    JSON.stringify(rec.jsonld),
    { pageUrl }
  );

  // Check for actionable issues
  const issueList = formatIssuesForRefinement(
    fixResult.validationAfter.errors,
    fixResult.validationAfter.warnings
  );

  // If no actionable issues, return immediately
  if (!issueList) {
    return {
      schema: fixResult.fixed,
      fixResult,
      enhancementNotes: [],
      refinementPasses: 0,
    };
  }

  let bestFixResult = fixResult;
  let enhancementNotes: string[] = [];
  let passesRan = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    try {
      const currentSchema = bestFixResult.fixed;
      const currentIssueList = formatIssuesForRefinement(
        bestFixResult.validationAfter.errors,
        bestFixResult.validationAfter.warnings
      );

      // No more actionable issues
      if (!currentIssueList) break;

      // Call AI to refine
      const refinementOutput = await refineSchema(
        currentSchema,
        currentIssueList,
        pageUrl
      );

      // Fix + validate the refined output
      const refinedFixResult = fixAndValidateAIOutputWithContext(
        JSON.stringify(refinementOutput.refined),
        { pageUrl }
      );

      // Regression guard: if refined has MORE errors, discard
      if (
        refinedFixResult.validationAfter.errors.length >
        bestFixResult.validationAfter.errors.length
      ) {
        // Keep enhancement notes from the attempt even if we discard the schema
        enhancementNotes = refinementOutput.enhancementNotes;
        break;
      }

      // Type guard: @type must not change
      if (refinedFixResult.fixed["@type"] !== bestFixResult.fixed["@type"]) {
        enhancementNotes = refinementOutput.enhancementNotes;
        break;
      }

      // Accept the refinement
      bestFixResult = refinedFixResult;
      enhancementNotes = refinementOutput.enhancementNotes;
      passesRan = pass + 1;
    } catch (err) {
      console.error("[refinement] pass failed, keeping pre-refinement result:", err);
      break;
    }
  }

  return {
    schema: bestFixResult.fixed,
    fixResult: bestFixResult,
    enhancementNotes,
    refinementPasses: passesRan,
  };
}

/**
 * Process a list of AI recommendations through the refinement loop in parallel.
 * Returns ValidatedRecommendation[] with enhancementNotes populated.
 */
export async function refineAllRecommendations(
  recommendations: SchemaRecommendation[],
  pageUrl: string,
  html: string
): Promise<ValidatedRecommendation[]> {
  const results = await Promise.all(
    recommendations.map((rec) => refineAndValidate(rec, pageUrl, html))
  );

  return recommendations.map((rec, i) => {
    const result = results[i];
    return {
      ...rec,
      jsonld: result.schema,
      validation: result.fixResult.validationAfter,
      fixes: result.fixResult.fixes,
      enhancementNotes: result.enhancementNotes,
      refinementPasses: result.refinementPasses,
    };
  });
}
