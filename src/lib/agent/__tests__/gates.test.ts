import { describe, it, expect } from "vitest";
import { runGates, schemaTypesOf, hasCriticalIssue } from "../gates";
import { gatesPassed } from "../types";
import type { ValidationResult } from "@/lib/validation/types";

// A schema the real validation engine accepts (copied from engine.test fixtures).
const validProduct = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Summer Collection Tee",
  description: "A lightweight cotton t-shirt.",
  image: "https://example.com/tee.jpg",
  sku: "TEE-001",
  brand: { "@type": "Brand", name: "Acme" },
  offers: {
    "@type": "Offer",
    price: 29.99,
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    url: "https://example.com/tee",
  },
};

const base = {
  requireTypes: ["Product"],
  minOutcome: "valid" as const,
  beforeErrorCount: 0,
  beforeHadSchema: false,
};

describe("runGates", () => {
  it("L0 fails when there are no candidates", () => {
    const g = runGates({ ...base, candidates: [] });
    expect(g.L0.passed).toBe(false);
    expect(g.L1.passed).toBe(false);
  });

  it("passes L0/L1 for a valid required-type schema", () => {
    const g = runGates({ ...base, candidates: [validProduct] });
    expect(g.L0.passed).toBe(true);
    expect(g.L1.passed).toBe(true);
    expect(g.L2).toBeNull(); // not requested
    expect(g.L3.passed).toBe(true);
  });

  it("L1 fails when a candidate is invalid, and names the specific error", () => {
    const g = runGates({ ...base, candidates: [{ "@type": "Product" }] });
    expect(g.L1.passed).toBe(false);
    // The detail must name the type + the real validation message, not a generic string,
    // so the operator sees WHAT is wrong (the per-page reason line surfaces this).
    expect(g.L1.detail).toMatch(/Product:/);
    expect(g.L1.detail).not.toBe("one or more candidate schemas are invalid");
  });

  it("L1 fails when the required type is absent", () => {
    const g = runGates({
      ...base,
      requireTypes: ["Article"],
      candidates: [validProduct],
    });
    expect(g.L1.passed).toBe(false);
    expect(g.L1.detail).toMatch(/Article/);
  });

  it("L2 passes for a rich-eligible valid type when rich is required", () => {
    const g = runGates({
      ...base,
      minOutcome: "rich_results_eligible",
      candidates: [validProduct],
    });
    expect(g.L2?.passed).toBe(true);
  });

  it("does not pass a rich goal when the required type is not rich-eligible", () => {
    // CollectionPage isn't rich-eligible, and a Product candidate can't satisfy
    // a CollectionPage requirement — the gates must not pass either way.
    const g = runGates({
      ...base,
      requireTypes: ["CollectionPage"],
      minOutcome: "rich_results_eligible",
      candidates: [validProduct],
    });
    expect(gatesPassed(g)).toBe(false);
  });

  it("L3 fails when the candidate regresses (more errors than current)", () => {
    const g = runGates({
      ...base,
      beforeHadSchema: true,
      beforeErrorCount: 0,
      candidates: [{ "@type": "Product" }], // invalid -> >0 errors
    });
    expect(g.L3.passed).toBe(false);
  });

  it("L3 passes when there is no prior schema", () => {
    const g = runGates({
      ...base,
      beforeHadSchema: false,
      candidates: [{ "@type": "Product" }],
    });
    expect(g.L3.passed).toBe(true);
  });

});

// Issue #28: per-type bars. A page can require one type at the rich bar and
// another that only ever has to validate (rich-ineligible types like WebSite).
describe("runGates with per-type requirements", () => {
  const validWebSite = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Acme",
    url: "https://example.com",
  };
  const validOrg = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Acme",
    url: "https://example.com",
  };

  it("a rich-ineligible type at the 'valid' bar passes alongside a rich-bar type", () => {
    // The homepage row of the matrix: Organization@rich + WebSite@valid. A global
    // rich bar would be unsatisfiable (WebSite is permanently ineligible).
    const g = runGates({
      ...base,
      requirements: [
        { type: "Organization", outcome: "rich_results_eligible" },
        { type: "WebSite", outcome: "valid" },
      ],
      candidates: [validOrg, validWebSite],
    });
    expect(gatesPassed(g)).toBe(true);
    expect(g.L2?.passed).toBe(true); // evaluated — for Organization only
  });

  it("L2 is null when no requirement carries the rich bar", () => {
    const g = runGates({
      ...base,
      requirements: [{ type: "WebSite", outcome: "valid" }],
      candidates: [validWebSite],
    });
    expect(g.L2).toBeNull();
    expect(gatesPassed(g)).toBe(true);
  });

  it("requirements REPLACE requireTypes/minOutcome when present", () => {
    // base says Product@valid; requirements demand WebSite — and win.
    const g = runGates({
      ...base,
      requirements: [{ type: "WebSite", outcome: "valid" }],
      candidates: [validProduct],
    });
    expect(g.L1.passed).toBe(false);
    expect(g.L1.detail).toMatch(/WebSite/);
  });

  it("a missing rich-bar type still fails L1 (per-type sets are complete sets)", () => {
    const g = runGates({
      ...base,
      requirements: [
        { type: "Product", outcome: "rich_results_eligible" },
        { type: "BreadcrumbList", outcome: "rich_results_eligible" },
      ],
      candidates: [validProduct],
    });
    expect(g.L1.passed).toBe(false);
    expect(g.L1.detail).toMatch(/BreadcrumbList/);
  });
});

describe("schemaTypesOf", () => {
  it("normalizes string, array, and missing @type", () => {
    expect(schemaTypesOf({ "@type": "Product" })).toEqual(["Product"]);
    expect(schemaTypesOf({ "@type": ["Product", "Offer"] })).toEqual([
      "Product",
      "Offer",
    ]);
    expect(schemaTypesOf({})).toEqual([]);
    expect(schemaTypesOf(null)).toEqual([]);
  });
});

describe("hasCriticalIssue", () => {
  const vr = (errors: { code: string }[], warnings: { code: string }[]): ValidationResult =>
    ({
      valid: errors.length === 0,
      errors: errors.map((e) => ({ severity: "error", path: "$", message: "", code: e.code })),
      warnings: warnings.map((w) => ({ severity: "warning", path: "$", message: "", code: w.code })),
      summary: { errorCount: errors.length, warningCount: warnings.length, schemaType: "Product", validationTimeMs: 0 },
    }) as unknown as ValidationResult;

  it("is true for a critical-impact code", () => {
    expect(hasCriticalIssue(vr([{ code: "MISSING_REQUIRED" }], []))).toBe(true);
  });

  it("is false when only recommended/best-practice issues exist", () => {
    expect(hasCriticalIssue(vr([], [{ code: "MISSING_RECOMMENDED" }]))).toBe(false);
  });
});

describe("subtype-aware requirement matching (garnerandtow run-3 failures)", () => {
  it("a valid AboutPage satisfies a WebPage requirement at L1", () => {
    const aboutPage = {
      "@context": "https://schema.org",
      "@type": "AboutPage",
      name: "About Garner and Tow",
      url: "https://garnerandtow.com/pages/about",
      description: "Our story",
    };
    const result = runGates({
      candidates: [aboutPage],
      requireTypes: ["WebPage"],
      minOutcome: "valid",
      beforeErrorCount: 0,
      beforeHadSchema: false,
    });
    expect(result.L1.passed).toBe(true);
  });

  it("a BlogPosting satisfies an Article requirement, but not vice versa", () => {
    const blogPosting = {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "t",
      author: { "@type": "Person", name: "a" },
      datePublished: "2026-01-01",
    };
    const ok = runGates({
      candidates: [blogPosting],
      requireTypes: ["Article"],
      minOutcome: "valid",
      beforeErrorCount: 0,
      beforeHadSchema: false,
    });
    expect(ok.L1.passed).toBe(true);

    // The PARENT type never satisfies a more specific requirement.
    const article = { ...blogPosting, "@type": "Article" };
    const notOk = runGates({
      candidates: [article],
      requireTypes: ["BlogPosting"],
      minOutcome: "valid",
      beforeErrorCount: 0,
      beforeHadSchema: false,
    });
    expect(notOk.L1.passed).toBe(false);
    expect(notOk.L1.detail).toContain("BlogPosting");
  });
});
