import { describe, it, expect } from "vitest";
import { computeScore } from "../compute-score";
import type { OptimizeResponse, SchemaComparison } from "@/lib/optimizer/types";
import type { ValidatedRecommendation } from "@/lib/ai/types";
import type { ValidationResult } from "@/lib/validation/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeValidation(
  errors: number = 0,
  warnings: number = 0
): ValidationResult {
  return {
    valid: errors === 0,
    errors: Array.from({ length: errors }, (_, i) => ({
      path: "$.test",
      message: `Error ${i}`,
      severity: "error" as const,
      code: "MISSING_REQUIRED",
    })),
    warnings: Array.from({ length: warnings }, (_, i) => ({
      path: "$.test",
      message: `Warning ${i}`,
      severity: "warning" as const,
      code: "MISSING_RECOMMENDED",
    })),
    summary: {
      errorCount: errors,
      warningCount: warnings,
      schemaType: null,
      validationTimeMs: 0,
    },
  };
}

function makeComparison(opts: {
  schemaType?: string;
  hasExisting?: boolean;
  existingErrors?: number;
  hasFixed?: boolean;
  fixCount?: number;
  fixResolvedCount?: number;
  hasGenerated?: boolean;
  generatedResolvedCount?: number;
}): SchemaComparison {
  const {
    schemaType = "Product",
    hasExisting = false,
    existingErrors = 0,
    hasFixed = false,
    fixCount = 0,
    fixResolvedCount = 0,
    hasGenerated = false,
    generatedResolvedCount = 0,
  } = opts;

  return {
    schemaType,
    source: hasExisting && hasGenerated ? "both" : hasExisting ? "existing" : "generated",
    existing: hasExisting
      ? {
          schema: { "@type": schemaType, name: "Test" },
          validation: makeValidation(existingErrors),
          raw: "{}",
        }
      : null,
    fixed: hasFixed
      ? {
          schema: { "@type": schemaType, name: "Test" },
          validation: makeValidation(),
          fixesApplied: Array.from({ length: fixCount }, () => ({
            path: "$.test",
            code: "MISSING_REQUIRED",
            description: "Fixed something",
          })),
          resolvedFromOriginal: Array.from({ length: fixResolvedCount }, () => ({
            originalError: {
              path: "$.test",
              message: "Was broken",
              severity: "error" as const,
              code: "MISSING_REQUIRED",
            },
            resolution: "auto_fixed" as const,
            description: "Fixed it",
          })),
          remainingErrors: [],
        }
      : null,
    generated: hasGenerated
      ? {
          type: schemaType,
          priority: 1 as const,
          rationale: "Test rationale",
          jsonld: { "@type": schemaType, name: "Test" },
          shopifyInstructions: "",
          validation: makeValidation(),
          fixes: [],
          resolvedFromOriginal: Array.from({ length: generatedResolvedCount }, () => ({
            originalError: {
              path: "$.test",
              message: "Was broken",
              severity: "error" as const,
              code: "MISSING_REQUIRED",
            },
            resolution: "ai_generated" as const,
            description: "AI fixed it",
          })),
        }
      : null,
  };
}

function makeRecommendation(type: string = "BreadcrumbList"): ValidatedRecommendation {
  return {
    type,
    priority: 2,
    rationale: "Good to have",
    jsonld: { "@type": type, name: "Test" },
    shopifyInstructions: "",
    validation: makeValidation(),
    fixes: [],
  };
}

function makeResponse(
  overrides: Partial<OptimizeResponse> = {}
): OptimizeResponse {
  return {
    url: "https://example.com",
    finalUrl: "https://example.com",
    fetchStatusCode: 200,
    pageType: "product",
    comparisons: [],
    newRecommendations: [],
    missingOpportunities: [],
    notes: [],
    ...overrides,
  };
}

// ─── Summary Stats ────────────────────────────────────────────────────────────

describe("computeScore — summary stats", () => {
  it("returns zero counts and 'No changes needed' for empty response", () => {
    const result = computeScore(makeResponse());

    expect(result.schemasFixed).toBe(0);
    expect(result.schemasAdded).toBe(0);
    expect(result.issuesResolved).toBe(0);
    expect(result.summary).toBe("No changes needed");
  });

  it("counts schemasFixed from comparisons with fixes applied", () => {
    const result = computeScore(
      makeResponse({
        comparisons: [
          makeComparison({ hasExisting: true, hasFixed: true, fixCount: 2 }),
          makeComparison({ schemaType: "Organization", hasExisting: true, hasFixed: true, fixCount: 0 }),
          makeComparison({ schemaType: "WebSite", hasExisting: true, hasFixed: true, fixCount: 1 }),
        ],
      })
    );

    // Only comparisons with fixCount > 0 count
    expect(result.schemasFixed).toBe(2);
  });

  it("counts schemasAdded from newRecommendations", () => {
    const result = computeScore(
      makeResponse({
        newRecommendations: [
          makeRecommendation("BreadcrumbList"),
          makeRecommendation("Organization"),
        ],
      })
    );

    expect(result.schemasAdded).toBe(2);
  });

  it("counts issuesResolved using max of fixer and AI resolved counts", () => {
    const result = computeScore(
      makeResponse({
        comparisons: [
          // Fixer resolved 2, AI resolved 3 → takes max = 3
          makeComparison({
            hasExisting: true,
            existingErrors: 3,
            hasFixed: true,
            fixCount: 2,
            fixResolvedCount: 2,
            hasGenerated: true,
            generatedResolvedCount: 3,
          }),
          // Fixer resolved 1, no AI → takes max = 1
          makeComparison({
            schemaType: "Organization",
            hasExisting: true,
            existingErrors: 1,
            hasFixed: true,
            fixCount: 1,
            fixResolvedCount: 1,
          }),
        ],
      })
    );

    expect(result.issuesResolved).toBe(4); // 3 + 1
  });

  it("uses singular 'issue' and 'schema' when count is 1", () => {
    const result = computeScore(
      makeResponse({
        comparisons: [
          makeComparison({
            hasExisting: true,
            existingErrors: 1,
            hasFixed: true,
            fixCount: 1,
            fixResolvedCount: 1,
          }),
        ],
        newRecommendations: [makeRecommendation()],
      })
    );

    expect(result.summary).toContain("1 issue resolved");
    expect(result.summary).toContain("1 schema fixed");
    expect(result.summary).toContain("1 schema added");
    // No "s" plurals
    expect(result.summary).not.toContain("issues");
    expect(result.summary).not.toContain("schemas");
  });

  it("uses plural when counts are > 1", () => {
    const result = computeScore(
      makeResponse({
        comparisons: [
          makeComparison({
            hasExisting: true,
            existingErrors: 2,
            hasFixed: true,
            fixCount: 2,
            fixResolvedCount: 2,
            hasGenerated: true,
            generatedResolvedCount: 2,
          }),
          makeComparison({
            schemaType: "Organization",
            hasExisting: true,
            existingErrors: 1,
            hasFixed: true,
            fixCount: 1,
            fixResolvedCount: 1,
          }),
        ],
        newRecommendations: [
          makeRecommendation("BreadcrumbList"),
          makeRecommendation("WebSite"),
        ],
      })
    );

    expect(result.summary).toContain("issues resolved");
    expect(result.summary).toContain("schemas fixed");
    expect(result.summary).toContain("schemas added");
  });

  it("builds comma-separated summary with all parts present", () => {
    const result = computeScore(
      makeResponse({
        comparisons: [
          makeComparison({
            hasExisting: true,
            existingErrors: 2,
            hasFixed: true,
            fixCount: 1,
            fixResolvedCount: 2,
          }),
        ],
        newRecommendations: [makeRecommendation()],
      })
    );

    const parts = result.summary.split(", ");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/issues? resolved/);
    expect(parts[1]).toMatch(/schema(s)? fixed/);
    expect(parts[2]).toMatch(/schema(s)? added/);
  });

  it("omits parts with zero counts from summary", () => {
    const result = computeScore(
      makeResponse({
        newRecommendations: [makeRecommendation()],
      })
    );

    expect(result.summary).toBe("1 schema added");
    expect(result.summary).not.toContain("resolved");
    expect(result.summary).not.toContain("fixed");
  });
});

// ─── Delta ────────────────────────────────────────────────────────────────────

describe("computeScore — delta", () => {
  it("computes positive delta when after > before", () => {
    const result = computeScore(
      makeResponse({
        comparisons: [
          makeComparison({
            hasExisting: true,
            existingErrors: 3,
            hasGenerated: true,
          }),
        ],
      })
    );

    expect(result.delta).toBeGreaterThan(0);
    expect(result.delta).toBe(result.after.total - result.before.total);
  });

  it("delta is 0 when no existing schemas (before is all zeros)", () => {
    const result = computeScore(
      makeResponse({
        newRecommendations: [makeRecommendation()],
      })
    );

    expect(result.before.total).toBe(0);
    expect(result.delta).toBe(result.after.total);
  });
});
