import type {
  ValidationResult,
  ValidationIssue,
  FixApplied,
} from "@/lib/validation/types";
import type { ValidatedRecommendation } from "@/lib/ai/types";
import type { MissingOpportunity } from "@/lib/url-validator/types";

/** How an issue from the original schema was resolved */
export interface ResolvedIssue {
  originalError: ValidationIssue;
  resolution: "auto_fixed" | "ai_generated";
  description: string;
}

/** A single schema type's journey through the optimization pipeline */
export interface SchemaComparison {
  schemaType: string;
  source: "existing" | "generated" | "both";

  /** Box 1: Original schema as found on page */
  existing: {
    schema: Record<string, unknown>;
    validation: ValidationResult;
    raw: string;
  } | null;

  /** Box 2: Auto-fixed version (null if no existing or no fixes possible) */
  fixed: {
    schema: Record<string, unknown>;
    validation: ValidationResult;
    fixesApplied: FixApplied[];
    resolvedFromOriginal: ResolvedIssue[];
    remainingErrors: ValidationIssue[];
  } | null;

  /** Box 3: LLM-generated version */
  generated:
    | (ValidatedRecommendation & {
        resolvedFromOriginal: ResolvedIssue[];
      })
    | null;
}

export interface OptimizeResponse {
  url: string;
  finalUrl: string;
  fetchStatusCode: number;
  pageType: string;
  comparisons: SchemaComparison[];
  newRecommendations: ValidatedRecommendation[];
  missingOpportunities: MissingOpportunity[];
  notes: string[];
}
