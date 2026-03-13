import { describe, it, expect } from "vitest";
import { fixSchema } from "../fixer";

describe("fixSchema", () => {
  it("adds missing @context", () => {
    const schema = {
      "@type": "Product",
      name: "Test Product",
      offers: {
        "@type": "Offer",
        price: 29.99,
        priceCurrency: "USD",
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);

    expect(result.fixed["@context"]).toBe("https://schema.org");
    expect(result.fixes).toContainEqual(
      expect.objectContaining({
        code: "MISSING_CONTEXT",
        path: "@context",
      })
    );
  });

  it("normalizes invalid @context", () => {
    const schema = {
      "@context": "http://schema.com",
      "@type": "Product",
      name: "Test",
      offers: {
        "@type": "Offer",
        price: 10,
        priceCurrency: "USD",
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);

    expect(result.fixed["@context"]).toBe("https://schema.org");
    expect(result.fixes).toContainEqual(
      expect.objectContaining({ code: "INVALID_CONTEXT" })
    );
  });

  it("expands enum shorthand to full URL", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Test Product",
      offers: {
        "@type": "Offer",
        price: 29.99,
        priceCurrency: "USD",
        availability: "InStock",
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);
    const offers = result.fixed.offers as Record<string, unknown>;

    expect(offers.availability).toBe("https://schema.org/InStock");
    expect(result.fixes).toContainEqual(
      expect.objectContaining({
        code: "ENUM_FORMAT",
        description: expect.stringContaining("InStock"),
      })
    );
  });

  it("expands string brand to Brand object", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Test Product",
      brand: "Nike",
      offers: {
        "@type": "Offer",
        price: 29.99,
        priceCurrency: "USD",
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);

    expect(result.fixed.brand).toEqual({
      "@type": "Brand",
      name: "Nike",
    });
    expect(result.fixes).toContainEqual(
      expect.objectContaining({
        code: "SUBOPTIMAL_TYPE",
        description: expect.stringContaining("Nike"),
      })
    );
  });

  it("expands string author to Person object", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Test Article",
      author: "John Doe",
      datePublished: "2026-01-15",
    };

    const result = fixSchema(schema as Record<string, unknown>);

    expect(result.fixed.author).toEqual({
      "@type": "Person",
      name: "John Doe",
    });
    expect(result.fixes).toContainEqual(
      expect.objectContaining({ code: "SUBOPTIMAL_TYPE" })
    );
  });

  it("moves misplaced properties from Offer to Product", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Test Product",
      offers: {
        "@type": "Offer",
        price: 29.99,
        priceCurrency: "USD",
        color: "Red",
        sku: "SKU-123",
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);
    const offers = result.fixed.offers as Record<string, unknown>;

    // color and sku should be moved to Product level
    expect(result.fixed.color).toBe("Red");
    expect(result.fixed.sku).toBe("SKU-123");
    expect(offers.color).toBeUndefined();
    expect(offers.sku).toBeUndefined();

    const placementFixes = result.fixes.filter(
      (f) => f.code === "INVALID_PROPERTY_PLACEMENT"
    );
    expect(placementFixes.length).toBe(2);
  });

  it("passes through already-valid schema unchanged", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Valid Product",
      description: "A well-formed product",
      image: "https://example.com/img.jpg",
      brand: { "@type": "Brand", name: "Nike" },
      offers: {
        "@type": "Offer",
        price: 29.99,
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);

    expect(result.fixes).toHaveLength(0);
    expect(result.fixed).toEqual(schema);
  });

  it("applies multiple fixes at once", () => {
    const schema = {
      // missing @context
      "@type": "Product",
      name: "Test",
      brand: "Adidas", // string → object
      offers: {
        "@type": "Offer",
        price: 50,
        priceCurrency: "USD",
        availability: "OutOfStock", // shorthand enum
        color: "Blue", // wrong type
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);

    expect(result.fixed["@context"]).toBe("https://schema.org");
    expect(result.fixed.brand).toEqual({
      "@type": "Brand",
      name: "Adidas",
    });
    const offers = result.fixed.offers as Record<string, unknown>;
    expect(offers.availability).toBe("https://schema.org/OutOfStock");
    expect(result.fixed.color).toBe("Blue");
    expect(offers.color).toBeUndefined();

    // Should have at least 4 fixes
    expect(result.fixes.length).toBeGreaterThanOrEqual(4);
  });

  it("does not move property if parent already has it", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Test Product",
      color: "Blue",
      offers: {
        "@type": "Offer",
        price: 29.99,
        priceCurrency: "USD",
        color: "Red", // would conflict with existing Product.color
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);
    const offers = result.fixed.offers as Record<string, unknown>;

    // Parent already has color, so don't overwrite
    expect(result.fixed.color).toBe("Blue");
    // color stays on Offer since we can't safely move it
    expect(offers.color).toBe("Red");
  });

  it("handles itemCondition enum shorthand", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Test",
      offers: {
        "@type": "Offer",
        price: 10,
        priceCurrency: "USD",
        itemCondition: "NewCondition",
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);
    const offers = result.fixed.offers as Record<string, unknown>;

    expect(offers.itemCondition).toBe("https://schema.org/NewCondition");
  });

  it("validates before and after fixing", () => {
    const schema = {
      "@type": "Product",
      name: "Test",
      brand: "Nike",
      offers: {
        "@type": "Offer",
        price: 10,
        priceCurrency: "USD",
        availability: "InStock",
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);

    // Before should have issues
    expect(result.validationBefore.errors.length).toBeGreaterThan(0);
    // After should have fewer issues (context was missing)
    expect(
      result.validationAfter.errors.length
    ).toBeLessThan(result.validationBefore.errors.length);
  });
});
