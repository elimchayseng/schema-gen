/**
 * Integration layer (PRD Section 8, Component 3).
 *
 * Thin wrappers around the core validator for each integration point.
 * These exist so call sites are self-documenting and so we can add
 * integration-specific logic later without touching the core engine.
 */

import { validateSchema, validateSchemaString } from "./engine";
import type { ValidationResult } from "./types";

/**
 * Pre-deployment gate (PRD Section 9.2).
 * Returns whether deployment is allowed and the full validation result.
 */
export function canDeploy(jsonLd: unknown): {
  allowed: boolean;
  result: ValidationResult;
} {
  const result = validateSchema(jsonLd);
  return { allowed: result.valid, result };
}

/**
 * Validates AI-generated schema before displaying it to the user
 * (PRD Section 8.5 — AI Schema Generation integration point).
 */
export function validateAIOutput(jsonString: string): ValidationResult {
  return validateSchemaString(jsonString);
}

/**
 * Validates editor content on change — called by the useValidation
 * hook with debouncing (PRD Section 8.5 — Editor Real-time Feedback).
 */
export function validateEditorContent(jsonString: string): ValidationResult {
  return validateSchemaString(jsonString);
}

/**
 * Validates existing schema found during a site crawl
 * (PRD Section 8.5 — Crawl & Audit integration point).
 */
export function auditCrawledSchema(jsonLd: unknown): ValidationResult {
  return validateSchema(jsonLd);
}

/**
 * Validates multiple schemas in bulk — e.g. all pages in a workspace
 * or a template applied across page types
 * (PRD Section 8.5 — Bulk Operations integration point).
 */
export function validateBulk(
  schemas: Map<string, unknown>
): Map<string, ValidationResult> {
  const results = new Map<string, ValidationResult>();
  for (const [pageId, jsonLd] of schemas) {
    results.set(pageId, validateSchema(jsonLd));
  }
  return results;
}
