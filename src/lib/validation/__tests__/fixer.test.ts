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

  it("adds url to a nested publisher Organization from the document URL", () => {
    // The garnerandtow dry-run case: generated BlogPosting carries a name-only
    // publisher; our Organization quality bar wants url, and the document knows it.
    const schema = {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "Urban cycling in fall",
      author: { "@type": "Person", name: "G&T" },
      datePublished: "2026-01-01",
      url: "https://garnerandtow.com/blogs/press/urban-cycling",
      publisher: { "@type": "Organization", name: "Garner and Tow" },
    };

    const result = fixSchema(schema as Record<string, unknown>);

    const publisher = (result.fixed as { publisher: { url?: string } }).publisher;
    expect(publisher.url).toBe("https://garnerandtow.com");
    expect(
      result.fixes.some(
        (f) => f.path === "publisher.url" && f.code === "MISSING_REQUIRED"
      )
    ).toBe(true);
    expect(
      result.validationAfter.errors.filter((e) =>
        e.message.includes("'url' is missing from Organization")
      )
    ).toHaveLength(0);
  });

  it("leaves a root Organization and url-carrying nested Organizations alone", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Garner and Tow",
      // No url on the ROOT org: that's a content decision, not mechanical — no fix.
    };
    const result = fixSchema(schema as Record<string, unknown>);
    expect((result.fixed as { url?: string }).url).toBeUndefined();

    const withUrl = {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "t",
      author: { "@type": "Person", name: "a" },
      datePublished: "2026-01-01",
      url: "https://garnerandtow.com/x",
      publisher: {
        "@type": "Organization",
        name: "G&T",
        url: "https://example.com/keep-me",
      },
    };
    const r2 = fixSchema(withUrl as Record<string, unknown>);
    expect(
      (r2.fixed as { publisher: { url: string } }).publisher.url
    ).toBe("https://example.com/keep-me");
  });

  it("does nothing when the document carries no absolute URL", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "t",
      author: { "@type": "Person", name: "a" },
      datePublished: "2026-01-01",
      publisher: { "@type": "Organization", name: "G&T" },
    };
    const result = fixSchema(schema as Record<string, unknown>);
    expect(
      (result.fixed as { publisher: { url?: string } }).publisher.url
    ).toBeUndefined();
  });
});

describe("fixSchemaWithContext ordering (garnerandtow run-3 articles)", () => {
  it("fills publisher.url even when the document url itself is auto-filled", async () => {
    const { fixSchemaWithContext } = await import("../fixer");
    // Generated Article with NO url anywhere — exactly what generation produced.
    const schema = {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Urban cycling in fall",
      author: { "@type": "Person", name: "G&T" },
      datePublished: "2026-01-01",
      publisher: { "@type": "Organization", name: "Garner and Tow" },
    };
    const result = fixSchemaWithContext(schema as Record<string, unknown>, {
      pageUrl: "https://garnerandtow.com/blogs/press/urban-cycling",
    });
    const fixed = result.fixed as {
      url?: string;
      publisher: { url?: string };
    };
    expect(fixed.url).toBe("https://garnerandtow.com/blogs/press/urban-cycling");
    expect(fixed.publisher.url).toBe("https://garnerandtow.com");
    expect(
      result.validationAfter.errors.filter((e) =>
        e.message.includes("'url' is missing from Organization")
      )
    ).toHaveLength(0);
  });
});
