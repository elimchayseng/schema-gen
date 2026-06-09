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

  it("normalizes a wrong-protocol enum (http://schema.org → https://schema.org)", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Test Product",
      offers: {
        "@type": "Offer",
        price: 29.99,
        priceCurrency: "USD",
        availability: "http://schema.org/InStock",
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);
    const offers = result.fixed.offers as Record<string, unknown>;

    expect(offers.availability).toBe("https://schema.org/InStock");
    expect(result.validationAfter.valid).toBe(true);
  });

  it("normalizes a wrong-case enum segment", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Test Product",
      offers: {
        "@type": "Offer",
        price: 29.99,
        priceCurrency: "USD",
        availability: "https://schema.org/instock",
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);
    const offers = result.fixed.offers as Record<string, unknown>;

    expect(offers.availability).toBe("https://schema.org/InStock");
  });

  it("removes a redundant misplaced property when the parent already has it", () => {
    // sku on BOTH Product and Offer — can't move (Product has one), so drop the Offer copy.
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Test Product",
      sku: "PROD-1",
      image: "https://x.com/i.jpg",
      offers: {
        "@type": "Offer",
        price: 49,
        priceCurrency: "USD",
        sku: "OFFER-1",
        availability: "https://schema.org/InStock",
      },
    };
    const result = fixSchema(schema as Record<string, unknown>);
    const offers = result.fixed.offers as Record<string, unknown>;
    expect(offers.sku).toBeUndefined();
    expect(result.fixed.sku).toBe("PROD-1"); // the Product's own sku is untouched
    expect(result.validationAfter.valid).toBe(true);
  });

  it("reduces an image given as an ImageObject to its URL string", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Test Product",
      image: { "@type": "ImageObject", url: "https://x.com/i.jpg" },
      offers: {
        "@type": "Offer",
        price: 49,
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
      },
    };
    const result = fixSchema(schema as Record<string, unknown>);
    expect(result.fixed.image).toBe("https://x.com/i.jpg");
    expect(result.validationAfter.valid).toBe(true);
  });

  it("reduces an image given as an array of ImageObjects to a single URL string", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Test Product",
      image: [{ "@type": "ImageObject", url: "https://x.com/a.jpg" }],
      offers: {
        "@type": "Offer",
        price: 49,
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
      },
    };
    const result = fixSchema(schema as Record<string, unknown>);
    expect(result.fixed.image).toBe("https://x.com/a.jpg");
    expect(result.validationAfter.valid).toBe(true);
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

  it("drops a misplaced property (without overwriting) when the parent already has it", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Test Product",
      color: "Blue",
      offers: {
        "@type": "Offer",
        price: 29.99,
        priceCurrency: "USD",
        color: "Red", // conflicts with the Product's own color
      },
    };

    const result = fixSchema(schema as Record<string, unknown>);
    const offers = result.fixed.offers as Record<string, unknown>;

    // The Product's own color is authoritative and is never overwritten…
    expect(result.fixed.color).toBe("Blue");
    // …and the redundant copy is removed from Offer (leaving it there is invalid).
    expect(offers.color).toBeUndefined();
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
