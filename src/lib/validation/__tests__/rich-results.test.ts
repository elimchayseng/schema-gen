/**
 * Issue #21 — Google Rich Results parity.
 * Covers the per-type requirement checks (rich-results-requirements.ts) and the
 * 2026-06 eligibility audit of the rich-results map (deprecated features).
 * Parity mapping doc: docs/agent/rich-results-parity.md
 */
import { describe, it, expect } from "vitest";
import { checkRichResultsRequirements } from "../rich-results-requirements";
import { getRichResultInfo, getSeverityContext } from "../rich-results";
import { validateSchema } from "../engine";

describe("checkRichResultsRequirements", () => {
  describe("Product (one of offers/review/aggregateRating)", () => {
    const base = { "@context": "https://schema.org", "@type": "Product", name: "X" };

    it("flags a Product with none of offers/review/aggregateRating as an error", () => {
      const issues = checkRichResultsRequirements(base, "Product");
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("error");
      expect(issues[0].code).toBe("RICH_RESULTS_REQUIREMENT");
      expect(issues[0].path).toBe("offers");
    });

    it.each([
      ["offers", { "@type": "Offer", price: 1, priceCurrency: "USD" }],
      ["aggregateRating", { "@type": "AggregateRating", ratingValue: 5, reviewCount: 1 }],
      ["review", [{ "@type": "Review" }]],
    ])("passes when '%s' is present", (key, value) => {
      const issues = checkRichResultsRequirements({ ...base, [key]: value }, "Product");
      expect(issues).toHaveLength(0);
    });

    it("treats empty array/string values as absent", () => {
      expect(
        checkRichResultsRequirements({ ...base, review: [], offers: "" }, "Product")
      ).toHaveLength(1);
    });

    it("warns when AggregateRating has neither ratingCount nor reviewCount", () => {
      const issues = checkRichResultsRequirements(
        { ...base, aggregateRating: { "@type": "AggregateRating", ratingValue: 5 } },
        "Product"
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("warning");
      expect(issues[0].path).toBe("aggregateRating.reviewCount");
    });

    it("accepts AggregateRating with a reviewCount", () => {
      const issues = checkRichResultsRequirements(
        {
          ...base,
          aggregateRating: { "@type": "AggregateRating", ratingValue: 5, reviewCount: 3 },
        },
        "Product"
      );
      expect(issues).toHaveLength(0);
    });
  });

  describe("BreadcrumbList (minimum two ListItems)", () => {
    const item = (position: number) => ({
      "@type": "ListItem",
      position,
      name: `L${position}`,
      item: `https://x.com/${position}`,
    });

    it("warns on a single-item breadcrumb", () => {
      const issues = checkRichResultsRequirements(
        { "@type": "BreadcrumbList", itemListElement: [item(1)] },
        "BreadcrumbList"
      );
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("warning");
      expect(issues[0].code).toBe("RICH_RESULTS_REQUIREMENT");
    });

    it("passes with two items", () => {
      const issues = checkRichResultsRequirements(
        { "@type": "BreadcrumbList", itemListElement: [item(1), item(2)] },
        "BreadcrumbList"
      );
      expect(issues).toHaveLength(0);
    });

    it("does not duplicate the structural missing-itemListElement error", () => {
      // A missing array is the engine's MISSING_REQUIRED, not ours.
      expect(
        checkRichResultsRequirements({ "@type": "BreadcrumbList" }, "BreadcrumbList")
      ).toHaveLength(0);
    });
  });

  it("is wired into validateSchema (engine emits the issues)", () => {
    const result = validateSchema({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "No commerce data",
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "RICH_RESULTS_REQUIREMENT")
    ).toBe(true);
  });
});

describe("rich-results eligibility map (2026-06 audit)", () => {
  it("Product, BreadcrumbList, Organization remain eligible", () => {
    expect(getRichResultInfo("Product")?.eligible).toBe(true);
    expect(getRichResultInfo("BreadcrumbList")?.eligible).toBe(true);
    expect(getRichResultInfo("Organization")?.eligible).toBe(true);
  });

  it("HowTo is no longer eligible (deprecated by Google in Sept 2023)", () => {
    expect(getRichResultInfo("HowTo")?.eligible).toBe(false);
  });

  it("FAQPage is no longer eligible (removed by Google in May 2026)", () => {
    expect(getRichResultInfo("FAQPage")?.eligible).toBe(false);
  });

  it("WebSite is no longer eligible (sitelinks search box retired Nov 2024)", () => {
    expect(getRichResultInfo("WebSite")?.eligible).toBe(false);
  });
});

describe("getSeverityContext", () => {
  it("maps RICH_RESULTS_REQUIREMENT to critical impact (blocks the agent's L2 gate)", () => {
    const ctx = getSeverityContext("RICH_RESULTS_REQUIREMENT");
    expect(ctx?.impact).toBe("critical");
  });
});
