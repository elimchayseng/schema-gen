/**
 * Defines which schema.org types are expected for each page type.
 * Page types come from the LLM's `pageType` field in OptimizeResponse.
 */

export type ExpectationLevel = "required" | "recommended" | "optional";

export interface SchemaExpectation {
  schemaType: string;
  level: ExpectationLevel;
  /** Points weight within coverage score (higher = more important) */
  weight: number;
}

const expectations: Record<string, SchemaExpectation[]> = {
  product: [
    { schemaType: "Product", level: "required", weight: 10 },
    { schemaType: "BreadcrumbList", level: "recommended", weight: 4 },
    { schemaType: "Organization", level: "optional", weight: 2 },
    { schemaType: "WebSite", level: "optional", weight: 2 },
  ],
  homepage: [
    { schemaType: "WebSite", level: "required", weight: 10 },
    { schemaType: "Organization", level: "recommended", weight: 6 },
    { schemaType: "LocalBusiness", level: "optional", weight: 3 },
  ],
  blog_post: [
    { schemaType: "Article", level: "required", weight: 8 },
    { schemaType: "BlogPosting", level: "required", weight: 8 },
    { schemaType: "BreadcrumbList", level: "recommended", weight: 4 },
    { schemaType: "WebSite", level: "optional", weight: 2 },
  ],
  article: [
    { schemaType: "Article", level: "required", weight: 10 },
    { schemaType: "BreadcrumbList", level: "recommended", weight: 4 },
    { schemaType: "WebSite", level: "optional", weight: 2 },
  ],
  category: [
    { schemaType: "BreadcrumbList", level: "required", weight: 8 },
    { schemaType: "WebSite", level: "recommended", weight: 4 },
    { schemaType: "Organization", level: "optional", weight: 2 },
  ],
  collection: [
    { schemaType: "BreadcrumbList", level: "required", weight: 8 },
    { schemaType: "WebSite", level: "recommended", weight: 4 },
    { schemaType: "Organization", level: "optional", weight: 2 },
  ],
  contact: [
    { schemaType: "Organization", level: "required", weight: 8 },
    { schemaType: "LocalBusiness", level: "recommended", weight: 6 },
    { schemaType: "BreadcrumbList", level: "optional", weight: 3 },
  ],
  faq: [
    { schemaType: "FAQPage", level: "required", weight: 10 },
    { schemaType: "BreadcrumbList", level: "recommended", weight: 4 },
  ],
  about: [
    { schemaType: "Organization", level: "required", weight: 8 },
    { schemaType: "BreadcrumbList", level: "recommended", weight: 4 },
    { schemaType: "WebSite", level: "optional", weight: 2 },
  ],
};

/** Fallback for unknown page types */
const defaultExpectations: SchemaExpectation[] = [
  { schemaType: "WebSite", level: "recommended", weight: 5 },
  { schemaType: "BreadcrumbList", level: "recommended", weight: 4 },
  { schemaType: "Organization", level: "optional", weight: 3 },
];

/**
 * Get schema expectations for a given page type.
 * For blog_post, both Article and BlogPosting satisfy the "article" requirement —
 * if either is present, we count the highest-weighted match.
 */
export function getExpectations(pageType: string): SchemaExpectation[] {
  const normalized = pageType.toLowerCase().replace(/[\s-]/g, "_");
  return expectations[normalized] ?? defaultExpectations;
}
