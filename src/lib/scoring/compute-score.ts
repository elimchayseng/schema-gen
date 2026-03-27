import type { OptimizeResponse, SchemaComparison } from "@/lib/optimizer/types";
import type { ValidatedRecommendation } from "@/lib/ai/types";
import type { ValidationResult } from "@/lib/validation/types";
import { getExpectations, type SchemaExpectation } from "./page-expectations";

export interface ScoreBreakdown {
  coverage: number; // 0-40
  quality: number; // 0-40
  completeness: number; // 0-20
  total: number; // 0-100
}

export interface ScoreResult {
  before: ScoreBreakdown;
  after: ScoreBreakdown;
  delta: number;
  summary: string;
  schemasFixed: number;
  schemasAdded: number;
  issuesResolved: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getSchemaTypes(comparisons: SchemaComparison[]): Set<string> {
  return new Set(comparisons.map((c) => c.schemaType));
}

function qualityForValidation(v: ValidationResult): number {
  let score = 1.0;
  score -= v.errors.length * 0.15;
  score -= v.warnings.length * 0.05;
  return Math.max(0, score);
}

function countRecommendedPresent(schema: Record<string, unknown>): {
  present: number;
  total: number;
} {
  // Count non-null, non-undefined, non-empty-string properties as "present"
  // This is a rough proxy — we can't know which are "recommended" without
  // cross-referencing schema-definitions, but property count serves as a
  // reasonable completeness heuristic
  const keys = Object.keys(schema).filter(
    (k) => !k.startsWith("@") && schema[k] != null && schema[k] !== ""
  );
  // Assume a well-filled schema has ~8-12 meaningful properties
  const expectedPropertyCount = 10;
  return { present: Math.min(keys.length, expectedPropertyCount), total: expectedPropertyCount };
}

// ── Coverage Score ───────────────────────────────────────────────────────

function computeCoverage(
  expectations: SchemaExpectation[],
  presentTypes: Set<string>,
  getValidation: (type: string) => ValidationResult | null
): number {
  if (expectations.length === 0) return 40;

  const totalWeight = expectations.reduce((sum, e) => sum + e.weight, 0);
  let earned = 0;

  for (const exp of expectations) {
    // For blog_post, Article and BlogPosting are interchangeable
    const isPresent =
      presentTypes.has(exp.schemaType) ||
      (exp.schemaType === "Article" && presentTypes.has("BlogPosting")) ||
      (exp.schemaType === "BlogPosting" && presentTypes.has("Article"));

    if (!isPresent) continue;

    const validation = getValidation(exp.schemaType);
    if (!validation) {
      earned += exp.weight * 0.4;
      continue;
    }

    if (validation.errors.length === 0 && validation.warnings.length === 0) {
      earned += exp.weight;
    } else if (validation.errors.length === 0) {
      earned += exp.weight * 0.8;
    } else {
      earned += exp.weight * 0.4;
    }
  }

  return Math.round((earned / totalWeight) * 40);
}

// ── Quality Score ────────────────────────────────────────────────────────

function computeQuality(validations: ValidationResult[]): number {
  if (validations.length === 0) return 0;

  const total = validations.reduce(
    (sum, v) => sum + qualityForValidation(v),
    0
  );
  return Math.round((total / validations.length) * 40);
}

// ── Completeness Score ───────────────────────────────────────────────────

function computeCompleteness(schemas: Record<string, unknown>[]): number {
  if (schemas.length === 0) return 0;

  let totalPresent = 0;
  let totalExpected = 0;

  for (const schema of schemas) {
    const { present, total } = countRecommendedPresent(schema);
    totalPresent += present;
    totalExpected += total;
  }

  if (totalExpected === 0) return 0;
  return Math.round((totalPresent / totalExpected) * 20);
}

// ── Main ─────────────────────────────────────────────────────────────────

export function computeScore(response: OptimizeResponse): ScoreResult {
  const expectations = getExpectations(response.pageType);

  // ── Before score (existing schemas only) ──
  const existingTypes = new Set<string>();
  const existingValidations: ValidationResult[] = [];
  const existingSchemas: Record<string, unknown>[] = [];

  for (const c of response.comparisons) {
    if (c.existing) {
      existingTypes.add(c.schemaType);
      existingValidations.push(c.existing.validation);
      existingSchemas.push(c.existing.schema);
    }
  }

  const beforeCoverage = computeCoverage(expectations, existingTypes, (type) => {
    const match = response.comparisons.find(
      (c) => c.schemaType === type && c.existing
    );
    return match?.existing?.validation ?? null;
  });
  const beforeQuality = computeQuality(existingValidations);
  const beforeCompleteness = computeCompleteness(existingSchemas);

  const before: ScoreBreakdown = {
    coverage: beforeCoverage,
    quality: beforeQuality,
    completeness: beforeCompleteness,
    total: beforeCoverage + beforeQuality + beforeCompleteness,
  };

  // ── After score (best available for each + new recommendations) ──
  const afterTypes = new Set<string>(existingTypes);
  const afterValidations: ValidationResult[] = [];
  const afterSchemas: Record<string, unknown>[] = [];

  for (const c of response.comparisons) {
    if (c.generated) {
      afterValidations.push(c.generated.validation);
      afterSchemas.push(c.generated.jsonld);
    } else if (c.fixed) {
      afterValidations.push(c.fixed.validation);
      afterSchemas.push(c.fixed.schema);
    } else if (c.existing) {
      afterValidations.push(c.existing.validation);
      afterSchemas.push(c.existing.schema);
    }
  }

  for (const rec of response.newRecommendations) {
    afterTypes.add(rec.type);
    afterValidations.push(rec.validation);
    afterSchemas.push(rec.jsonld);
  }

  const afterCoverage = computeCoverage(expectations, afterTypes, (type) => {
    const match = response.comparisons.find((c) => c.schemaType === type);
    if (match?.generated) return match.generated.validation;
    if (match?.fixed) return match.fixed.validation;
    const rec = response.newRecommendations.find((r) => r.type === type);
    return rec?.validation ?? match?.existing?.validation ?? null;
  });
  const afterQuality = computeQuality(afterValidations);
  const afterCompleteness = computeCompleteness(afterSchemas);

  const after: ScoreBreakdown = {
    coverage: afterCoverage,
    quality: afterQuality,
    completeness: afterCompleteness,
    total: afterCoverage + afterQuality + afterCompleteness,
  };

  // ── Summary stats ──
  const schemasFixed = response.comparisons.filter(
    (c) => c.fixed && c.fixed.fixesApplied.length > 0
  ).length;
  const schemasAdded = response.newRecommendations.length;
  const issuesResolved = response.comparisons.reduce((sum, c) => {
    const fixerResolved = c.fixed?.resolvedFromOriginal.length ?? 0;
    const aiResolved = c.generated?.resolvedFromOriginal.length ?? 0;
    return sum + Math.max(fixerResolved, aiResolved);
  }, 0);

  const delta = after.total - before.total;

  // Build summary
  const parts: string[] = [];
  if (issuesResolved > 0)
    parts.push(`${issuesResolved} issue${issuesResolved !== 1 ? "s" : ""} resolved`);
  if (schemasFixed > 0)
    parts.push(`${schemasFixed} schema${schemasFixed !== 1 ? "s" : ""} fixed`);
  if (schemasAdded > 0)
    parts.push(`${schemasAdded} schema${schemasAdded !== 1 ? "s" : ""} added`);
  if (parts.length === 0) parts.push("No changes needed");

  return {
    before,
    after,
    delta,
    summary: parts.join(", "),
    schemasFixed,
    schemasAdded,
    issuesResolved,
  };
}
