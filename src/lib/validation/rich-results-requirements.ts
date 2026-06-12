/**
 * Per-type Google Rich Results requirement checks (issue #21).
 *
 * The structural validator (engine.ts + schema-definitions.ts) checks
 * schema.org shape. Google's rich-results features add their OWN requirements
 * on top — some conditional ("one of the following") in a way a flat
 * required/recommended property table cannot express. This module encodes
 * those documented rules; the engine runs it on every root schema so the
 * agent's deterministic gates (L1/L2) and the UI see the violations without
 * any LLM involvement.
 *
 * Parity mapping vs Google's docs: docs/agent/rich-results-parity.md
 *
 * Sources (accessed 2026-06-09):
 * - https://developers.google.com/search/docs/appearance/structured-data/product-snippet
 * - https://developers.google.com/search/docs/appearance/structured-data/breadcrumb
 * - https://developers.google.com/search/docs/appearance/structured-data/review-snippet
 */
import type { ValidationIssue } from "./types";

/** Present per Google's semantics: missing, null, "" and [] all count as absent. */
function present(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

/**
 * Product snippets: `name` plus ONE OF `review`, `aggregateRating`, `offers`
 * is required. A Product with none of the three can never produce a rich
 * result, so this is a blocking error (severity "error" keeps the agent's
 * repair loop targeting it; `name` itself is covered by schema-definitions).
 */
function checkProduct(obj: Record<string, unknown>): ValidationIssue[] {
  if (!present(obj["offers"]) && !present(obj["review"]) && !present(obj["aggregateRating"])) {
    return [
      {
        severity: "error",
        path: "offers",
        message:
          "Google requires one of 'offers', 'review', or 'aggregateRating' on Product for rich-results eligibility — none are present.",
        code: "RICH_RESULTS_REQUIREMENT",
        expectedValue: "offers | review | aggregateRating",
        suggestion:
          'Add an Offer with price and priceCurrency (e.g. {"@type": "Offer", "price": 29.99, "priceCurrency": "USD"}), or real review/aggregateRating data.',
      },
    ];
  }

  // Google requires at least one of ratingCount/reviewCount on AggregateRating.
  // Warning severity: the markup is structurally valid, but the rating cannot
  // render — and if it is the Product's only one-of basis, eligibility is lost.
  const issues: ValidationIssue[] = [];
  const rating = obj["aggregateRating"];
  if (rating !== null && typeof rating === "object" && !Array.isArray(rating)) {
    const r = rating as Record<string, unknown>;
    if (!present(r["ratingCount"]) && !present(r["reviewCount"])) {
      issues.push({
        severity: "warning",
        path: "aggregateRating.reviewCount",
        message:
          "Google requires at least one of 'ratingCount' or 'reviewCount' on AggregateRating for rich results.",
        code: "RICH_RESULTS_REQUIREMENT",
        expectedValue: "ratingCount | reviewCount",
      });
    }
  }
  return issues;
}

/**
 * Breadcrumb rich results require at least two ListItems. A shorter list is
 * structurally fine, so this is a warning — but it still blocks eligibility
 * (mapped to "critical" impact in getSeverityContext).
 */
function checkBreadcrumbList(obj: Record<string, unknown>): ValidationIssue[] {
  const items = obj["itemListElement"];
  if (!Array.isArray(items) || items.length >= 2) return [];
  return [
    {
      severity: "warning",
      path: "itemListElement",
      message:
        "Google requires at least two ListItem entries in a BreadcrumbList for breadcrumb rich results.",
      code: "RICH_RESULTS_REQUIREMENT",
      actualValue: items.length,
      expectedValue: ">= 2 ListItem entries",
    },
  ];
}

/**
 * Returns Google rich-results requirement violations for a root schema.
 * Issues carry their own severity: "error" = the feature can never render
 * (and the agent must repair), "warning" = eligibility-blocking but
 * structurally valid markup.
 */
export function checkRichResultsRequirements(
  obj: Record<string, unknown>,
  schemaType: string
): ValidationIssue[] {
  switch (schemaType) {
    case "Product":
      return checkProduct(obj);
    case "BreadcrumbList":
      return checkBreadcrumbList(obj);
    default:
      return [];
  }
}
