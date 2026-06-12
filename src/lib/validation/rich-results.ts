/**
 * Google Rich Result eligibility per schema.org type.
 * Used to show users which types qualify for enhanced search results.
 *
 * Sources:
 * - https://developers.google.com/search/docs/appearance/structured-data/search-gallery
 * - https://developers.google.com/search/docs/appearance/structured-data
 *
 * Audited against Google's docs on 2026-06-09 (issue #21). Deprecations since
 * the map was first written: HowTo rich results (Sept 2023), sitelinks search
 * box / WebSite (Nov 2024), FAQ rich results (restricted to gov/health sites
 * in 2023, removed entirely May 2026). Full mapping, including intentional
 * deviations, in docs/agent/rich-results-parity.md.
 */

export interface RichResultInfo {
  /** Whether Google shows enhanced search features for this type */
  eligible: boolean;
  /** The Google Rich Result feature name */
  feature: string;
  /** Short description for display */
  description: string;
}

const richResults: Record<string, RichResultInfo> = {
  Product: {
    eligible: true,
    feature: "Product snippets",
    description:
      "Shows price, availability, and review ratings directly in search results.",
  },
  Offer: {
    eligible: false,
    feature: "Nested type",
    description: "Used within Product to describe pricing and availability.",
  },
  Organization: {
    eligible: true,
    feature: "Knowledge panel",
    description: "Powers the knowledge panel for your organization in search.",
  },
  LocalBusiness: {
    eligible: true,
    feature: "Local business panel",
    description:
      "Shows address, hours, and contact info in Maps and search results.",
  },
  WebSite: {
    eligible: false,
    feature: "Deprecated (sitelinks search box)",
    description:
      "Google retired the sitelinks search box in November 2024. WebSite markup still helps Google understand your site name but produces no rich result.",
  },
  FAQPage: {
    eligible: false,
    feature: "Deprecated (FAQ rich results)",
    description:
      "Google restricted FAQ rich results to authoritative government/health sites in 2023 and removed them entirely in May 2026.",
  },
  Article: {
    eligible: true,
    feature: "Article rich results",
    description:
      "Enhanced display with headline, image, and date in search results.",
  },
  BlogPosting: {
    eligible: true,
    feature: "Article rich results",
    description:
      "Enhanced display with headline, image, and date in search results.",
  },
  BreadcrumbList: {
    eligible: true,
    feature: "Breadcrumb trails",
    description:
      "Shows page hierarchy path instead of raw URL in search results.",
  },
  AggregateRating: {
    eligible: false,
    feature: "Nested type",
    description: "Used within Product or LocalBusiness to show star ratings.",
  },
  Review: {
    eligible: true,
    feature: "Review snippets",
    description: "Shows star ratings and review information in search results.",
  },
  HowTo: {
    eligible: false,
    feature: "Deprecated (how-to rich results)",
    description:
      "Google deprecated how-to rich results in September 2023. HowTo markup is still valid schema.org but produces no rich result.",
  },
  CollectionPage: {
    eligible: false,
    feature: "Supported type",
    description:
      "Recognized by Google but does not generate a specific rich result.",
  },
  ItemList: {
    eligible: true,
    feature: "Carousel",
    description:
      "Can trigger a carousel of items in search results.",
  },
  WebPage: {
    eligible: false,
    feature: "Supported type",
    description:
      "Recognized by Google but does not generate a specific rich result.",
  },
  AboutPage: {
    eligible: false,
    feature: "Supported type",
    description:
      "Recognized by Google but does not generate a specific rich result.",
  },
  ContactPage: {
    eligible: false,
    feature: "Supported type",
    description:
      "Recognized by Google but does not generate a specific rich result.",
  },
};

/**
 * Get Rich Result eligibility info for a schema type.
 * Returns undefined for nested-only types (HowToStep, ListItem, etc.)
 */
export function getRichResultInfo(
  schemaType: string
): RichResultInfo | undefined {
  return richResults[schemaType];
}

/**
 * Returns a contextual label for a validation error code,
 * helping users understand real-world impact.
 */
export function getSeverityContext(
  code: string
): { label: string; impact: "critical" | "recommended" | "best-practice" } | undefined {
  switch (code) {
    case "MISSING_REQUIRED":
      return {
        label: "Google requires this field",
        impact: "critical",
      };
    case "MISSING_RECOMMENDED":
      return {
        label: "Recommended for rich results",
        impact: "recommended",
      };
    case "UNKNOWN_TYPE":
      return {
        label: "Not recognized \u2014 will be ignored by Google",
        impact: "critical",
      };
    case "INVALID_PROPERTY":
      return {
        label: "Not a valid schema.org property",
        impact: "critical",
      };
    case "INVALID_PROPERTY_PLACEMENT":
      return {
        label: "Property is on the wrong type",
        impact: "critical",
      };
    case "ENUM_FORMAT":
      return {
        label: "Best practice: use full URL format",
        impact: "best-practice",
      };
    case "INVALID_PROPERTY_TYPE":
      return {
        label: "Wrong value format",
        impact: "critical",
      };
    case "MISSING_CONTEXT":
    case "INVALID_CONTEXT":
      return {
        label: "Required for Google to process this schema",
        impact: "critical",
      };
    case "MISSING_TYPE":
      return {
        label: "Google cannot identify this schema without @type",
        impact: "critical",
      };
    case "RICH_RESULTS_REQUIREMENT":
      return {
        label: "Google requires this for rich results",
        impact: "critical",
      };
    default:
      return undefined;
  }
}
