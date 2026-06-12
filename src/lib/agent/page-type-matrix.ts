/**
 * Page-type → schema-type matrix (issue #28). The "whole site, one button" goal
 * needs different required types per page kind: a product page must carry
 * Product + BreadcrumbList, the homepage Organization + WebSite, and so on. One
 * global requireTypes can't express that — and one global rich bar can't either,
 * because rich-results.ts marks WebSite/CollectionPage/etc. permanently
 * ineligible. So each matrix entry carries its OWN outcome bar:
 *
 *   outcome "rich_results_eligible" — held to the rich bar, but only when the
 *     goal's minOutcome also demands it (a "valid"-only goal never asks for rich).
 *   outcome "valid" — only ever required to validate, even under a rich goal
 *     (the type can't produce a rich result, so demanding one is unsatisfiable).
 *
 * Pure and deterministic: no I/O, no model calls. classifyPageType encodes
 * Shopify's storefront path conventions, mirroring urlToTemplateTarget.
 */
import type { GoalTarget, MinOutcome, TypeRequirement } from "./types";

export type PageType = "home" | "product" | "collection" | "article" | "page";

/**
 * Every type below must exist in lib/validation/schema-definitions.ts (so L1 can
 * grade it) — WebPage was added there for this matrix.
 */
export const PAGE_TYPE_MATRIX: Record<PageType, TypeRequirement[]> = {
  home: [
    { type: "Organization", outcome: "rich_results_eligible" },
    { type: "WebSite", outcome: "valid" },
  ],
  product: [
    { type: "Product", outcome: "rich_results_eligible" },
    { type: "BreadcrumbList", outcome: "rich_results_eligible" },
  ],
  collection: [
    { type: "CollectionPage", outcome: "valid" },
    { type: "BreadcrumbList", outcome: "rich_results_eligible" },
  ],
  article: [
    { type: "BlogPosting", outcome: "valid" },
    { type: "BreadcrumbList", outcome: "rich_results_eligible" },
  ],
  page: [{ type: "WebPage", outcome: "valid" }],
};

/** Deterministic per-type priority for capped site runs: most valuable pages first. */
export const PAGE_TYPE_PRIORITY: Record<PageType, number> = {
  home: 0,
  product: 1,
  collection: 2,
  article: 3,
  page: 4,
};

/**
 * Classify a storefront URL into its page type via Shopify path conventions.
 * Returns null for paths the matrix has no entry for (cart, blog indexes,
 * search, ...) — those are simply not site-scope targets. Pure.
 *
 *   /                                -> home
 *   /products/<h>                    -> product
 *   /collections/<c>                 -> collection
 *   /collections/<c>/products/<h>    -> product (collection-scoped product URL)
 *   /blogs/<blog>/<article>          -> article
 *   /pages/<h>                       -> page
 */
export function classifyPageType(url: string): PageType | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  const seg = path.replace(/^\/+|\/+$/g, "").split("/");
  if (seg.length === 0 || seg[0] === "") return "home";

  switch (seg[0]) {
    case "products":
      return seg[1] ? "product" : null;
    case "collections":
      if (seg[2] === "products" && seg[3]) return "product";
      return seg[1] ? "collection" : null;
    case "blogs":
      // /blogs/<blog> alone is a blog index — no matrix entry.
      return seg[2] ? "article" : null;
    case "pages":
      return seg[1] ? "page" : null;
    default:
      return null;
  }
}

/** A goal's global requireTypes as per-page requirements, all at the goal's bar. */
export function uniformRequirements(
  requireTypes: string[],
  minOutcome: MinOutcome
): TypeRequirement[] {
  return requireTypes.map((type) => ({ type, outcome: minOutcome }));
}

/**
 * The matrix row for a page type, with each entry's bar clamped by the goal:
 * a type is only held to "rich_results_eligible" when BOTH the matrix marks it
 * rich-capable AND the goal asks for rich. Everything else is "valid".
 */
export function requirementsForPage(
  pageType: PageType,
  goalMinOutcome: MinOutcome
): TypeRequirement[] {
  return PAGE_TYPE_MATRIX[pageType].map((r) => ({
    type: r.type,
    outcome:
      r.outcome === "rich_results_eligible" &&
      goalMinOutcome === "rich_results_eligible"
        ? "rich_results_eligible"
        : "valid",
  }));
}

/**
 * The required types for one URL under a goal target. Scope "site" classifies the
 * URL and reads the matrix; every other scope keeps its pre-#28 behavior — the
 * global requireTypes, uniformly at the goal's minOutcome. An unclassifiable URL
 * under scope "site" yields no requirements (resolveTargetUrls never emits one).
 */
export function requirementsForTarget(
  target: GoalTarget,
  url: string
): TypeRequirement[] {
  if (target.scope === "site") {
    const pageType = classifyPageType(url);
    return pageType ? requirementsForPage(pageType, target.minOutcome) : [];
  }
  return uniformRequirements(target.requireTypes, target.minOutcome);
}
