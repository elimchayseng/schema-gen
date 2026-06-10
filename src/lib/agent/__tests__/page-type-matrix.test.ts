import { describe, it, expect } from "vitest";
import {
  classifyPageType,
  PAGE_TYPE_MATRIX,
  requirementsForPage,
  requirementsForTarget,
  uniformRequirements,
} from "../page-type-matrix";
import { schemaDefinitions } from "@/lib/validation/schema-definitions";
import type { GoalTarget } from "../types";

describe("classifyPageType", () => {
  it.each([
    ["https://shop.com/", "home"],
    ["https://shop.com", "home"],
    ["https://shop.com/products/blue-widget", "product"],
    ["https://shop.com/collections/sale", "collection"],
    ["https://shop.com/collections/sale/products/blue-widget", "product"],
    ["https://shop.com/blogs/news/my-post", "article"],
    ["https://shop.com/pages/about", "page"],
  ])("classifies %s as %s", (url, expected) => {
    expect(classifyPageType(url)).toBe(expected);
  });

  it.each([
    "https://shop.com/cart",
    "https://shop.com/blogs/news", // blog index — no matrix entry
    "https://shop.com/products", // listing root, no handle
    "https://shop.com/collections",
    "https://shop.com/pages",
    "https://shop.com/search",
  ])("returns null for %s", (url) => {
    expect(classifyPageType(url)).toBeNull();
  });

  it("accepts a bare path", () => {
    expect(classifyPageType("/products/x")).toBe("product");
    expect(classifyPageType("/")).toBe("home");
  });
});

describe("PAGE_TYPE_MATRIX", () => {
  it("every required type is known to the validation engine (L1 can grade it)", () => {
    for (const reqs of Object.values(PAGE_TYPE_MATRIX)) {
      for (const r of reqs) {
        expect(schemaDefinitions[r.type], `${r.type} missing`).toBeDefined();
      }
    }
  });

  it("encodes the issue #28 required sets per page type", () => {
    expect(PAGE_TYPE_MATRIX.home.map((r) => r.type)).toEqual([
      "Organization",
      "WebSite",
    ]);
    expect(PAGE_TYPE_MATRIX.product.map((r) => r.type)).toEqual([
      "Product",
      "BreadcrumbList",
    ]);
    expect(PAGE_TYPE_MATRIX.collection.map((r) => r.type)).toEqual([
      "CollectionPage",
      "BreadcrumbList",
    ]);
    expect(PAGE_TYPE_MATRIX.article.map((r) => r.type)).toEqual([
      "BlogPosting",
      "BreadcrumbList",
    ]);
    expect(PAGE_TYPE_MATRIX.page.map((r) => r.type)).toEqual(["WebPage"]);
  });
});

describe("requirementsForPage", () => {
  it("holds rich-capable types to the rich bar only under a rich goal", () => {
    expect(requirementsForPage("home", "rich_results_eligible")).toEqual([
      { type: "Organization", outcome: "rich_results_eligible" },
      { type: "WebSite", outcome: "valid" }, // valid-only even under a rich goal
    ]);
  });

  it("clamps everything to 'valid' under a valid-only goal", () => {
    expect(requirementsForPage("product", "valid")).toEqual([
      { type: "Product", outcome: "valid" },
      { type: "BreadcrumbList", outcome: "valid" },
    ]);
  });
});

describe("requirementsForTarget", () => {
  const siteTarget: GoalTarget = {
    scope: "site",
    requireTypes: [],
    minOutcome: "rich_results_eligible",
  };

  it("scope 'site' classifies the URL and reads the matrix", () => {
    expect(
      requirementsForTarget(siteTarget, "https://shop.com/collections/sale")
    ).toEqual([
      { type: "CollectionPage", outcome: "valid" },
      { type: "BreadcrumbList", outcome: "rich_results_eligible" },
    ]);
  });

  it("scope 'site' yields no requirements for an unclassifiable URL", () => {
    expect(requirementsForTarget(siteTarget, "https://shop.com/cart")).toEqual([]);
  });

  it("other scopes keep the pre-#28 uniform behavior", () => {
    const target: GoalTarget = {
      scope: "all_products",
      requireTypes: ["Product"],
      minOutcome: "rich_results_eligible",
    };
    expect(requirementsForTarget(target, "https://shop.com/pages/about")).toEqual(
      uniformRequirements(["Product"], "rich_results_eligible")
    );
  });
});
