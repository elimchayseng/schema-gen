import { describe, it, expect, vi, beforeEach } from "vitest";
import { processPage } from "../process-page";

// Mock all external dependencies
vi.mock("@/lib/url-validator/fetcher", () => ({
  fetchPage: vi.fn(),
}));

vi.mock("@/lib/url-validator/extractor", () => ({
  extractJsonLd: vi.fn(),
}));

vi.mock("@/lib/url-validator/opportunities", () => ({
  detectMissingOpportunities: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/validation/engine", () => ({
  validateSchema: vi.fn(),
}));

vi.mock("@/lib/validation/fixer", () => ({
  fixSchema: vi.fn(),
}));

vi.mock("@/lib/ai/client", () => ({
  generateSchemas: vi.fn(),
}));

vi.mock("@/lib/ai/refinement", () => ({
  refineAllRecommendations: vi.fn(),
}));

vi.mock("@/lib/validation/schema-definitions", () => ({
  schemaDefinitions: { Product: {}, Organization: {}, WebSite: {} },
}));

import { fetchPage } from "@/lib/url-validator/fetcher";
import { extractJsonLd } from "@/lib/url-validator/extractor";
import { validateSchema } from "@/lib/validation/engine";
import { fixSchema } from "@/lib/validation/fixer";
import { generateSchemas } from "@/lib/ai/client";
import { refineAllRecommendations } from "@/lib/ai/refinement";

const mockFetchPage = vi.mocked(fetchPage);
const mockExtractJsonLd = vi.mocked(extractJsonLd);
const mockValidateSchema = vi.mocked(validateSchema);
const mockFixSchema = vi.mocked(fixSchema);
const mockGenerateSchemas = vi.mocked(generateSchemas);
const mockRefineAll = vi.mocked(refineAllRecommendations);

describe("processPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("scan mode", () => {
    it("returns valid status for page with valid schema", async () => {
      mockFetchPage.mockResolvedValue({
        html: "<html></html>",
        finalUrl: "https://example.com/",
        statusCode: 200,
      });

      mockExtractJsonLd.mockReturnValue([
        {
          raw: '{"@type":"Product"}',
          parsed: { "@type": "Product", "@context": "https://schema.org", name: "Tee" },
          parseError: undefined,
          position: 0,
        },
      ]);

      mockValidateSchema.mockReturnValue({
        valid: true,
        errors: [],
        warnings: [],
        summary: { errorCount: 0, warningCount: 0, schemaType: "Product", validationTimeMs: 1 },
      });

      mockFixSchema.mockReturnValue({
        original: { "@type": "Product", "@context": "https://schema.org", name: "Tee" },
        fixed: { "@type": "Product", "@context": "https://schema.org", name: "Tee" },
        fixes: [],
        validationBefore: {
          valid: true, errors: [], warnings: [],
          summary: { errorCount: 0, warningCount: 0, schemaType: "Product", validationTimeMs: 1 },
        },
        validationAfter: {
          valid: true, errors: [], warnings: [],
          summary: { errorCount: 0, warningCount: 0, schemaType: "Product", validationTimeMs: 1 },
        },
      });

      const result = await processPage("https://example.com/", "scan");

      expect(result.status).toBe("valid");
      expect(result.originalSchemas).toHaveLength(1);
      expect(result.fixedSchemas).toHaveLength(1);
      expect(result.errorReason).toBeUndefined();
    });

    it("returns errors status for page with broken schema", async () => {
      mockFetchPage.mockResolvedValue({
        html: "<html></html>",
        finalUrl: "https://example.com/product",
        statusCode: 200,
      });

      mockExtractJsonLd.mockReturnValue([
        {
          raw: '{"@type":"Product"}',
          parsed: { "@type": "Product" },
          parseError: undefined,
          position: 0,
        },
      ]);

      mockValidateSchema.mockReturnValue({
        valid: false,
        errors: [{ severity: "error", path: "name", message: "Required", code: "MISSING_REQUIRED" }],
        warnings: [],
        summary: { errorCount: 1, warningCount: 0, schemaType: "Product", validationTimeMs: 1 },
      });

      mockFixSchema.mockReturnValue({
        original: { "@type": "Product" },
        fixed: { "@type": "Product" },
        fixes: [],
        validationBefore: {
          valid: false,
          errors: [{ severity: "error", path: "name", message: "Required", code: "MISSING_REQUIRED" }],
          warnings: [],
          summary: { errorCount: 1, warningCount: 0, schemaType: "Product", validationTimeMs: 1 },
        },
        validationAfter: {
          valid: false,
          errors: [{ severity: "error", path: "name", message: "Required", code: "MISSING_REQUIRED" }],
          warnings: [],
          summary: { errorCount: 1, warningCount: 0, schemaType: "Product", validationTimeMs: 1 },
        },
      });

      const result = await processPage("https://example.com/product", "scan");

      expect(result.status).toBe("errors");
      expect(result.originalSchemas).toHaveLength(1);
      expect(result.validationResults?.errorCount).toBe(1);
    });

    it("returns no_schema for page with no JSON-LD", async () => {
      mockFetchPage.mockResolvedValue({
        html: "<html><body>Hello</body></html>",
        finalUrl: "https://example.com/about",
        statusCode: 200,
      });

      mockExtractJsonLd.mockReturnValue([]);

      const result = await processPage("https://example.com/about", "scan");

      expect(result.status).toBe("no_schema");
      expect(result.originalSchemas).toBeNull();
      expect(result.fixedSchemas).toBeNull();
    });

    it("returns failed status on fetch failure", async () => {
      mockFetchPage.mockResolvedValue({
        html: "",
        finalUrl: "https://example.com/broken",
        statusCode: 403,
        error: "Forbidden",
      });

      const result = await processPage("https://example.com/broken", "scan");

      expect(result.status).toBe("failed");
      expect(result.errorReason).toBe("Forbidden");
    });

    it("returns failed status on fetch error (network)", async () => {
      mockFetchPage.mockRejectedValue(new Error("Connection refused"));

      const result = await processPage("https://example.com/down", "scan");

      expect(result.status).toBe("failed");
      expect(result.errorReason).toBe("Connection refused");
    });

    it("handles page with multiple schemas", async () => {
      mockFetchPage.mockResolvedValue({
        html: "<html></html>",
        finalUrl: "https://example.com/",
        statusCode: 200,
      });

      mockExtractJsonLd.mockReturnValue([
        {
          raw: '{"@type":"Product"}',
          parsed: { "@type": "Product", "@context": "https://schema.org", name: "A" },
          parseError: undefined,
          position: 0,
        },
        {
          raw: '{"@type":"Organization"}',
          parsed: { "@type": "Organization", "@context": "https://schema.org", name: "B" },
          parseError: undefined,
          position: 100,
        },
      ]);

      mockValidateSchema.mockReturnValue({
        valid: true, errors: [], warnings: [],
        summary: { errorCount: 0, warningCount: 0, schemaType: "Product", validationTimeMs: 1 },
      });

      mockFixSchema.mockImplementation((schema) => ({
        original: schema as Record<string, unknown>,
        fixed: schema as Record<string, unknown>,
        fixes: [],
        validationBefore: { valid: true, errors: [], warnings: [], summary: { errorCount: 0, warningCount: 0, schemaType: "Product", validationTimeMs: 1 } },
        validationAfter: { valid: true, errors: [], warnings: [], summary: { errorCount: 0, warningCount: 0, schemaType: "Product", validationTimeMs: 1 } },
      }));

      const result = await processPage("https://example.com/", "scan");

      expect(result.status).toBe("valid");
      expect(result.originalSchemas).toHaveLength(2);
      expect(result.fixedSchemas).toHaveLength(2);
    });
  });

  // Issue #20e — pages with unparseable JSON-LD blocks are "invalid schema
  // present" (an error state), NEVER "schema missing". Treating them as missing
  // is what made the system generate a duplicate block on garnerandtow.com.
  describe("unparseable JSON-LD blocks (issue #20e)", () => {
    const unparseableBlock = {
      raw: '{"@type":"Product","additionalProperty":[{"value":"["gid://x"]"}]}',
      parsed: null,
      parseError: "Unexpected token g in JSON at position 42",
      position: 0,
    };

    beforeEach(() => {
      mockFetchPage.mockResolvedValue({
        html: "<html></html>",
        finalUrl: "https://example.com/products/duffel",
        statusCode: 200,
      });
    });

    it("scan mode: only-unparseable page is 'errors' with structured detail, not 'no_schema'", async () => {
      mockExtractJsonLd.mockReturnValue([unparseableBlock]);

      const result = await processPage("https://example.com/products/duffel", "scan");

      expect(result.status).toBe("errors");
      expect(result.validationResults?.errorCount).toBe(1);
      const entry = result.validationResults!.schemas[0];
      expect(entry.type).toBe("InvalidJSON");
      expect(entry.validation.errors[0].code).toBe("INVALID_JSON");
      expect(entry.validation.errors[0].message).toContain("could not be parsed");
      // The broken raw block is surfaced so the user/agent can see what is live
      expect(String(entry.validation.errors[0].actualValue)).toContain("gid://x");
      expect(result.fixedSchemas).toBeNull();
    });

    it("optimize mode: only-unparseable page does NOT AI-generate a duplicate block", async () => {
      mockExtractJsonLd.mockReturnValue([unparseableBlock]);

      const result = await processPage(
        "https://example.com/products/duffel",
        "optimize"
      );

      expect(result.status).toBe("errors");
      expect(mockGenerateSchemas).not.toHaveBeenCalled();
    });

    it("scan mode: valid block + unparseable block is 'errors', unparseable entries never enter fixedSchemas", async () => {
      mockExtractJsonLd.mockReturnValue([
        unparseableBlock,
        {
          raw: '{"@type":"Organization"}',
          parsed: { "@type": "Organization", "@context": "https://schema.org", name: "B" },
          parseError: undefined,
          position: 1,
        },
      ]);

      mockValidateSchema.mockReturnValue({
        valid: true, errors: [], warnings: [],
        summary: { errorCount: 0, warningCount: 0, schemaType: "Organization", validationTimeMs: 1 },
      });
      mockFixSchema.mockImplementation((schema) => ({
        original: schema as Record<string, unknown>,
        fixed: schema as Record<string, unknown>,
        fixes: [],
        validationBefore: { valid: true, errors: [], warnings: [], summary: { errorCount: 0, warningCount: 0, schemaType: "Organization", validationTimeMs: 1 } },
        validationAfter: { valid: true, errors: [], warnings: [], summary: { errorCount: 0, warningCount: 0, schemaType: "Organization", validationTimeMs: 1 } },
      }));

      const result = await processPage("https://example.com/products/duffel", "scan");

      expect(result.status).toBe("errors");
      expect(result.validationResults?.errorCount).toBe(1);
      expect(result.validationResults?.schemas).toHaveLength(2);
      // Only the real Organization schema is stageable
      expect(result.fixedSchemas).toHaveLength(1);
      expect(result.fixedSchemas![0]["@type"]).toBe("Organization");
    });
  });

  describe("optimize mode", () => {
    it("generates schemas via AI for pages with no existing schema", async () => {
      mockFetchPage.mockResolvedValue({
        html: "<html><body>Product page</body></html>",
        finalUrl: "https://example.com/product",
        statusCode: 200,
      });

      mockExtractJsonLd.mockReturnValue([]);

      mockGenerateSchemas.mockResolvedValue({
        pageType: "product",
        recommendations: [
          {
            type: "Product",
            priority: 1 as const,
            rationale: "Product page",
            jsonld: { "@type": "Product", "@context": "https://schema.org", name: "Tee" },
            shopifyInstructions: "Add to product template",
          },
        ],
        mergedJsonld: [],
        notes: [],
      });

      mockRefineAll.mockResolvedValue([
        {
          type: "Product",
          priority: 1 as const,
          rationale: "Product page",
          jsonld: { "@type": "Product", "@context": "https://schema.org", name: "Tee" },
          shopifyInstructions: "Add to product template",
          validation: {
            valid: true, errors: [], warnings: [],
            summary: { errorCount: 0, warningCount: 0, schemaType: "Product", validationTimeMs: 1 },
          },
          fixes: [],
          enhancementNotes: [],
          refinementPasses: 1,
        },
      ]);

      const result = await processPage("https://example.com/product", "optimize");

      expect(result.status).toBe("valid");
      expect(result.fixedSchemas).toHaveLength(1);
      expect(result.originalSchemas).toBeNull();
      expect(mockGenerateSchemas).toHaveBeenCalled();
    });

    it("returns the AI-REFINED schema as fixedSchemas for a page that already had schema", async () => {
      // Regression: the agent gates result.fixedSchemas. The had-schema path must surface the
      // AI-refined schema, NOT the weaker pre-AI auto-fix, or the agent discards the AI's work.
      const brokenProduct = { "@type": "Product", "@context": "https://schema.org", name: "Tee" };
      const autoFixedProduct = { ...brokenProduct }; // auto-fixer alone can't add offers
      const aiRefinedProduct = {
        "@type": "Product",
        "@context": "https://schema.org",
        name: "Tee",
        offers: { "@type": "Offer", price: 29.99, priceCurrency: "USD" },
      };

      mockFetchPage.mockResolvedValue({
        html: "<html></html>",
        finalUrl: "https://example.com/product",
        statusCode: 200,
      });
      mockExtractJsonLd.mockReturnValue([
        { raw: "{}", parsed: brokenProduct, parseError: undefined, position: 0 },
      ]);
      // Still invalid after the deterministic fixer (missing offers) -> triggers AI refine.
      mockValidateSchema.mockReturnValue({
        valid: false,
        errors: [{ severity: "error", path: "offers", message: "Required property 'offers' is missing from Product.", code: "MISSING_REQUIRED" }],
        warnings: [],
        summary: { errorCount: 1, warningCount: 0, schemaType: "Product", validationTimeMs: 1 },
      });
      mockFixSchema.mockReturnValue({
        original: brokenProduct,
        fixed: autoFixedProduct,
        fixes: [],
        validationBefore: { valid: false, errors: [{ severity: "error", path: "offers", message: "x", code: "MISSING_REQUIRED" }], warnings: [], summary: { errorCount: 1, warningCount: 0, schemaType: "Product", validationTimeMs: 1 } },
        validationAfter: { valid: false, errors: [{ severity: "error", path: "offers", message: "x", code: "MISSING_REQUIRED" }], warnings: [], summary: { errorCount: 1, warningCount: 0, schemaType: "Product", validationTimeMs: 1 } },
      });
      mockGenerateSchemas.mockResolvedValue({
        pageType: "product",
        recommendations: [
          { type: "Product", priority: 1 as const, rationale: "r", jsonld: aiRefinedProduct, shopifyInstructions: "s" },
        ],
        mergedJsonld: [],
        notes: [],
      });
      mockRefineAll.mockResolvedValue([
        {
          type: "Product",
          priority: 1 as const,
          rationale: "r",
          jsonld: aiRefinedProduct,
          shopifyInstructions: "s",
          validation: { valid: true, errors: [], warnings: [], summary: { errorCount: 0, warningCount: 0, schemaType: "Product", validationTimeMs: 1 } },
          fixes: [],
          enhancementNotes: [],
          refinementPasses: 1,
        },
      ]);

      const result = await processPage("https://example.com/product", "optimize");

      expect(result.fixedSchemas).toHaveLength(1);
      // The agent gates THIS — it must be the AI-refined Product (with offers), not the auto-fix.
      expect(result.fixedSchemas?.[0]).toHaveProperty("offers");
      expect(result.fixedSchemas?.[0]).toEqual(aiRefinedProduct);
    });

    it("requiredTypes: generation runs on an error-free page when a required type is missing, and the new block is ADDED (issue #28)", async () => {
      // A homepage carrying only a valid WebSite — Organization is required but absent.
      const website = { "@type": "WebSite", "@context": "https://schema.org", name: "Acme", url: "https://example.com" };
      const org = { "@type": "Organization", "@context": "https://schema.org", name: "Acme", url: "https://example.com" };
      const cleanValidation = {
        valid: true, errors: [], warnings: [],
        summary: { errorCount: 0, warningCount: 0, schemaType: "WebSite", validationTimeMs: 1 },
      };

      mockFetchPage.mockResolvedValue({
        html: "<html></html>",
        finalUrl: "https://example.com/",
        statusCode: 200,
      });
      mockExtractJsonLd.mockReturnValue([
        { raw: "{}", parsed: website, parseError: undefined, position: 0 },
      ]);
      mockValidateSchema.mockReturnValue(cleanValidation);
      mockFixSchema.mockReturnValue({
        original: website,
        fixed: website,
        fixes: [],
        validationBefore: cleanValidation,
        validationAfter: cleanValidation,
      });
      mockGenerateSchemas.mockResolvedValue({
        pageType: "homepage",
        recommendations: [
          { type: "Organization", priority: 1 as const, rationale: "r", jsonld: org, shopifyInstructions: "s" },
          // An unsolicited extra type must still be dropped (pre-#28 behavior kept).
          { type: "Product", priority: 3 as const, rationale: "r", jsonld: { "@type": "Product" }, shopifyInstructions: "s" },
        ],
        mergedJsonld: [],
        notes: [],
      });
      mockRefineAll.mockResolvedValue([
        {
          type: "Organization", priority: 1 as const, rationale: "r", jsonld: org, shopifyInstructions: "s",
          validation: { ...cleanValidation, summary: { ...cleanValidation.summary, schemaType: "Organization" } },
          fixes: [], enhancementNotes: [], refinementPasses: 1,
        },
        {
          type: "Product", priority: 3 as const, rationale: "r", jsonld: { "@type": "Product" }, shopifyInstructions: "s",
          validation: { ...cleanValidation, summary: { ...cleanValidation.summary, schemaType: "Product" } },
          fixes: [], enhancementNotes: [], refinementPasses: 1,
        },
      ]);

      const result = await processPage("https://example.com/", "optimize", undefined, {
        requiredTypes: ["Organization", "WebSite"],
      });

      // The hint reached the generator…
      expect(mockGenerateSchemas).toHaveBeenCalledWith(
        expect.any(String),
        "https://example.com/",
        ["Organization", "WebSite"]
      );
      // …and the missing required type was added; the unsolicited Product was not.
      const types = result.fixedSchemas?.map((s) => s["@type"]);
      expect(types).toEqual(["WebSite", "Organization"]);
    });

    it("requiredTypes already satisfied: an error-free page never triggers generation", async () => {
      const website = { "@type": "WebSite", "@context": "https://schema.org", name: "Acme", url: "https://example.com" };
      const cleanValidation = {
        valid: true, errors: [], warnings: [],
        summary: { errorCount: 0, warningCount: 0, schemaType: "WebSite", validationTimeMs: 1 },
      };
      mockFetchPage.mockResolvedValue({
        html: "<html></html>",
        finalUrl: "https://example.com/",
        statusCode: 200,
      });
      mockExtractJsonLd.mockReturnValue([
        { raw: "{}", parsed: website, parseError: undefined, position: 0 },
      ]);
      mockValidateSchema.mockReturnValue(cleanValidation);
      mockFixSchema.mockReturnValue({
        original: website,
        fixed: website,
        fixes: [],
        validationBefore: cleanValidation,
        validationAfter: cleanValidation,
      });

      const result = await processPage("https://example.com/", "optimize", undefined, {
        requiredTypes: ["WebSite"],
      });

      expect(result.status).toBe("valid");
      expect(mockGenerateSchemas).not.toHaveBeenCalled();
    });

    it("handles AI generation failure gracefully", async () => {
      mockFetchPage.mockResolvedValue({
        html: "<html></html>",
        finalUrl: "https://example.com/fail",
        statusCode: 200,
      });

      mockExtractJsonLd.mockReturnValue([]);
      mockGenerateSchemas.mockRejectedValue(new Error("LLM timeout"));

      const result = await processPage("https://example.com/fail", "optimize");

      expect(result.status).toBe("no_schema");
      expect(result.errorReason).toContain("AI generation failed");
    });
  });

  describe("fetchHeaders (password-gated storefront)", () => {
    it("forwards fetchHeaders to fetchPage so a gated dev store can be perceived", async () => {
      mockFetchPage.mockResolvedValue({
        html: "<html></html>",
        finalUrl: "https://shop.myshopify.com/products/x",
        statusCode: 200,
      });
      mockExtractJsonLd.mockReturnValue([]);

      await processPage("https://shop.myshopify.com/products/x", "scan", undefined, {
        fetchHeaders: { Cookie: "storefront_digest=abc123" },
      });

      expect(mockFetchPage).toHaveBeenCalledWith(
        "https://shop.myshopify.com/products/x",
        { headers: { Cookie: "storefront_digest=abc123" } }
      );
    });

    it("fetches anonymously (empty opts) when no fetchHeaders are given", async () => {
      mockFetchPage.mockResolvedValue({
        html: "<html></html>",
        finalUrl: "https://example.com/",
        statusCode: 200,
      });
      mockExtractJsonLd.mockReturnValue([]);

      await processPage("https://example.com/", "scan");

      expect(mockFetchPage).toHaveBeenCalledWith("https://example.com/", {});
    });
  });
});
