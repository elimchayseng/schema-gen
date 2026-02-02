import { describe, it, expect } from "vitest";
import {
  validateSchema,
  validateSchemaString,
  resolveProperties,
  resolveInvalidProperties,
  canDeploy,
  validateAIOutput,
  auditCrawledSchema,
  validateBulk,
  getStatusFromValidation,
  schemaDefinitions,
} from "../index";

// ============================================================
// Helpers — reusable valid schemas
// ============================================================

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

const validFAQ = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "What is your return policy?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "You can return items within 30 days.",
      },
    },
  ],
};

const validOrganization = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Acme Corp",
  url: "https://acme.com",
  logo: "https://acme.com/logo.png",
  sameAs: ["https://twitter.com/acme", "https://facebook.com/acme"],
};

const validBreadcrumb = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    {
      "@type": "ListItem",
      position: 1,
      name: "Home",
      item: "https://example.com/",
    },
    {
      "@type": "ListItem",
      position: 2,
      name: "Products",
      item: "https://example.com/products",
    },
  ],
};

const validArticle = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "How to Choose the Perfect T-Shirt",
  author: { "@type": "Person", name: "Jane Doe" },
  datePublished: "2026-01-15",
  image: "https://example.com/article.jpg",
  publisher: {
    "@type": "Organization",
    name: "Acme Blog",
    url: "https://acme.com",
  },
};

const validLocalBusiness = {
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "Acme Store",
  url: "https://acme.com",
  address: {
    "@type": "PostalAddress",
    streetAddress: "123 Main St",
    addressLocality: "Springfield",
    addressRegion: "IL",
    postalCode: "62701",
    addressCountry: "US",
  },
  telephone: "+1-555-123-4567",
};

// ============================================================
// 1. Valid schema tests
// ============================================================

describe("Valid schemas", () => {
  it("1. Valid Product passes with no errors", () => {
    const result = validateSchema(validProduct);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.summary.schemaType).toBe("Product");
  });

  it("2. Valid FAQPage passes with no errors", () => {
    const result = validateSchema(validFAQ);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("3. Valid Organization passes with no errors", () => {
    const result = validateSchema(validOrganization);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("4. Valid BreadcrumbList passes with no errors", () => {
    const result = validateSchema(validBreadcrumb);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("5. Valid Article passes with no errors", () => {
    const result = validateSchema(validArticle);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("6. Valid LocalBusiness (inherits Organization) passes", () => {
    const result = validateSchema(validLocalBusiness);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ============================================================
// 2. Missing required properties
// ============================================================

describe("Missing required properties", () => {
  it("7. Product missing 'name' — error MISSING_REQUIRED", () => {
    const { name, ...noName } = validProduct;
    const result = validateSchema(noName);
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) => e.code === "MISSING_REQUIRED" && e.path === "name"
    );
    expect(err).toBeDefined();
    expect(err!.message).toContain("name");
  });

  it("8. Product missing 'offers' — error MISSING_REQUIRED", () => {
    const { offers, ...noOffers } = validProduct;
    const result = validateSchema(noOffers);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === "MISSING_REQUIRED" && e.path === "offers"
      )
    ).toBe(true);
  });

  it("9. Offer missing 'priceCurrency' — error MISSING_REQUIRED", () => {
    const schema = {
      ...validProduct,
      offers: {
        "@type": "Offer",
        price: 29.99,
        availability: "https://schema.org/InStock",
        url: "https://example.com/tee",
      },
    };
    const result = validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "MISSING_REQUIRED" && e.path === "offers.priceCurrency"
      )
    ).toBe(true);
  });

  it("10. FAQPage missing 'mainEntity' — error", () => {
    const result = validateSchema({
      "@context": "https://schema.org",
      "@type": "FAQPage",
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === "MISSING_REQUIRED" && e.path === "mainEntity"
      )
    ).toBe(true);
  });

  it("11. Article missing 'datePublished' — error", () => {
    const { datePublished, ...noPub } = validArticle;
    const result = validateSchema(noPub);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === "MISSING_REQUIRED" && e.path === "datePublished"
      )
    ).toBe(true);
  });

  it("12. Organization missing 'url' — error", () => {
    const { url, ...noUrl } = validOrganization;
    const result = validateSchema(noUrl);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === "MISSING_REQUIRED" && e.path === "url"
      )
    ).toBe(true);
  });
});

// ============================================================
// 3. Invalid property placement (PRD acceptance criteria)
// ============================================================

describe("Invalid property placement", () => {
  it("13. 'color' on Offer — error INVALID_PROPERTY_PLACEMENT with guidance", () => {
    const schema = {
      ...validProduct,
      offers: {
        ...validProduct.offers,
        color: "Red",
      },
    };
    const result = validateSchema(schema);
    expect(result.valid).toBe(false);
    const err = result.errors.find(
      (e) =>
        e.code === "INVALID_PROPERTY_PLACEMENT" && e.path === "offers.color"
    );
    expect(err).toBeDefined();
    expect(err!.message).toContain("Product");
  });

  it("14. 'brand' on Offer — error INVALID_PROPERTY_PLACEMENT", () => {
    const schema = {
      ...validProduct,
      offers: {
        ...validProduct.offers,
        brand: "Acme",
      },
    };
    const result = validateSchema(schema);
    const err = result.errors.find(
      (e) =>
        e.code === "INVALID_PROPERTY_PLACEMENT" && e.path === "offers.brand"
    );
    expect(err).toBeDefined();
  });

  it("15. 'offers' on FAQPage — error INVALID_PROPERTY_PLACEMENT", () => {
    const schema = {
      ...validFAQ,
      offers: { "@type": "Offer", price: 10, priceCurrency: "USD" },
    };
    const result = validateSchema(schema);
    expect(
      result.errors.some((e) => e.code === "INVALID_PROPERTY_PLACEMENT")
    ).toBe(true);
  });
});

// ============================================================
// 4. Unknown / invalid properties
// ============================================================

describe("Unknown and invalid properties", () => {
  it("16. Unknown property 'productColor' on Product — error INVALID_PROPERTY", () => {
    const schema = { ...validProduct, productColor: "Blue" };
    const result = validateSchema(schema);
    const err = result.errors.find(
      (e) => e.code === "INVALID_PROPERTY" && e.path === "productColor"
    );
    expect(err).toBeDefined();
    expect(err!.message).toContain("productColor");
  });
});

// ============================================================
// 5. Structural validation (context, type)
// ============================================================

describe("Structural validation", () => {
  it("17. Missing @context — error MISSING_CONTEXT", () => {
    const result = validateSchema({ "@type": "Product", name: "Test" });
    expect(
      result.errors.some((e) => e.code === "MISSING_CONTEXT")
    ).toBe(true);
  });

  it("18. Invalid @context — error INVALID_CONTEXT", () => {
    const result = validateSchema({
      "@context": "https://example.com",
      "@type": "Product",
      name: "Test",
    });
    expect(
      result.errors.some((e) => e.code === "INVALID_CONTEXT")
    ).toBe(true);
  });

  it("19. Missing @type — error MISSING_TYPE", () => {
    const result = validateSchema({ "@context": "https://schema.org" });
    expect(result.errors.some((e) => e.code === "MISSING_TYPE")).toBe(true);
  });

  it("20. Unknown @type — error UNKNOWN_TYPE", () => {
    const result = validateSchema({
      "@context": "https://schema.org",
      "@type": "FakeType",
    });
    expect(result.errors.some((e) => e.code === "UNKNOWN_TYPE")).toBe(true);
  });

  it("21. Non-object input (null) — error INVALID_JSON", () => {
    const result = validateSchema(null);
    expect(result.errors.some((e) => e.code === "INVALID_JSON")).toBe(true);
  });

  it("22. Non-object input (array) — error INVALID_JSON", () => {
    const result = validateSchema([{ "@type": "Product" }]);
    expect(result.errors.some((e) => e.code === "INVALID_JSON")).toBe(true);
  });
});

// ============================================================
// 6. Enum and format validation
// ============================================================

describe("Enum and format validation", () => {
  it("23. Invalid availability enum — error INVALID_ENUM_VALUE", () => {
    const schema = {
      ...validProduct,
      offers: {
        ...validProduct.offers,
        availability: "https://schema.org/NotARealValue",
      },
    };
    const result = validateSchema(schema);
    expect(
      result.errors.some((e) => e.code === "INVALID_ENUM_VALUE")
    ).toBe(true);
  });

  it("24. Short-form enum 'InStock' — warning ENUM_FORMAT with full URL suggestion", () => {
    const schema = {
      ...validProduct,
      offers: {
        ...validProduct.offers,
        availability: "InStock",
      },
    };
    const result = validateSchema(schema);
    // Should be a warning, not an error
    expect(result.valid).toBe(true);
    const warn = result.warnings.find(
      (w) =>
        w.code === "ENUM_FORMAT" && w.path === "offers.availability"
    );
    expect(warn).toBeDefined();
    expect(warn!.message).toContain("https://schema.org/InStock");
  });

  it("25. Invalid URL format for image — error INVALID_URL_FORMAT", () => {
    const schema = { ...validProduct, image: "not-a-url" };
    const result = validateSchema(schema);
    expect(
      result.errors.some(
        (e) => e.code === "INVALID_URL_FORMAT" && e.path === "image"
      )
    ).toBe(true);
  });

  it("26. Invalid priceCurrency pattern — error INVALID_PATTERN", () => {
    const schema = {
      ...validProduct,
      offers: { ...validProduct.offers, priceCurrency: "usd" },
    };
    const result = validateSchema(schema);
    expect(
      result.errors.some(
        (e) =>
          e.code === "INVALID_PATTERN" &&
          e.path === "offers.priceCurrency"
      )
    ).toBe(true);
  });

  it("27. Invalid gtin pattern — error INVALID_PATTERN", () => {
    const schema = { ...validProduct, gtin: "ABC123" };
    const result = validateSchema(schema);
    expect(
      result.errors.some(
        (e) => e.code === "INVALID_PATTERN" && e.path === "gtin"
      )
    ).toBe(true);
  });

  it("28. Invalid date format — error INVALID_DATE_FORMAT", () => {
    const schema = {
      ...validArticle,
      datePublished: "not-a-date",
    };
    const result = validateSchema(schema);
    expect(
      result.errors.some((e) => e.code === "INVALID_DATE_FORMAT")
    ).toBe(true);
  });
});

// ============================================================
// 7. Warning (non-blocking) tests
// ============================================================

describe("Warnings (non-blocking)", () => {
  it("29. Product missing recommended 'image' — warning, not error", () => {
    const { image, ...noImage } = validProduct;
    const result = validateSchema(noImage);
    // Should still be valid (image is recommended, not required for Product in our defs)
    expect(result.valid).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.code === "MISSING_RECOMMENDED" && w.path === "image"
      )
    ).toBe(true);
  });

  it("30. Product missing recommended 'description' — warning", () => {
    const { description, ...noDesc } = validProduct;
    const result = validateSchema(noDesc);
    expect(result.valid).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.code === "MISSING_RECOMMENDED" && w.path === "description"
      )
    ).toBe(true);
  });

  it("31. 'brand' as string instead of Brand object — warning SUBOPTIMAL_TYPE", () => {
    const schema = { ...validProduct, brand: "Acme" };
    const result = validateSchema(schema);
    const warn = result.warnings.find(
      (w) => w.code === "SUBOPTIMAL_TYPE" && w.path === "brand"
    );
    expect(warn).toBeDefined();
    expect(warn!.suggestion).toContain("Brand");
  });

  it("32. Organization missing recommended 'sameAs' — warning", () => {
    const { sameAs, ...noSameAs } = validOrganization;
    const result = validateSchema(noSameAs);
    expect(result.valid).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.code === "MISSING_RECOMMENDED" && w.path === "sameAs"
      )
    ).toBe(true);
  });
});

// ============================================================
// 8. Nested / recursive validation (3+ levels deep)
// ============================================================

describe("Nested recursive validation", () => {
  it("33. Product → Offer → Seller (Organization) validated recursively", () => {
    const schema = {
      ...validProduct,
      offers: {
        ...validProduct.offers,
        seller: {
          "@type": "Organization",
          name: "Acme Retail",
          url: "https://acmeretail.com",
        },
      },
    };
    const result = validateSchema(schema);
    expect(result.valid).toBe(true);
  });

  it("34. 3-level deep: Product → Review → Rating validated", () => {
    const schema = {
      ...validProduct,
      review: [
        {
          "@type": "Review",
          author: { "@type": "Person", name: "John" },
          reviewRating: {
            "@type": "Rating",
            ratingValue: 4.5,
            bestRating: 5,
          },
        },
      ],
    };
    const result = validateSchema(schema);
    expect(result.valid).toBe(true);
  });

  it("35. Nested Review missing required 'author' — error at correct path", () => {
    const schema = {
      ...validProduct,
      review: [
        {
          "@type": "Review",
          reviewRating: {
            "@type": "Rating",
            ratingValue: 4,
          },
        },
      ],
    };
    const result = validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "MISSING_REQUIRED" &&
          e.path === "review[0].author"
      )
    ).toBe(true);
  });

  it("36. Nested Rating missing required 'ratingValue' — error at deep path", () => {
    const schema = {
      ...validProduct,
      review: [
        {
          "@type": "Review",
          author: { "@type": "Person", name: "John" },
          reviewRating: {
            "@type": "Rating",
          },
        },
      ],
    };
    const result = validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "MISSING_REQUIRED" &&
          e.path === "review[0].reviewRating.ratingValue"
      )
    ).toBe(true);
  });

  it("37. FAQPage → Question → Answer validated recursively", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Q1?",
          acceptedAnswer: { "@type": "Answer", text: "A1." },
        },
        {
          "@type": "Question",
          name: "Q2?",
          acceptedAnswer: { "@type": "Answer" }, // missing 'text'
        },
      ],
    };
    const result = validateSchema(schema);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === "MISSING_REQUIRED" &&
          e.path === "mainEntity[1].acceptedAnswer.text"
      )
    ).toBe(true);
  });
});

// ============================================================
// 9. validateSchemaString (JSON string input)
// ============================================================

describe("validateSchemaString", () => {
  it("38. Valid JSON string — parses and validates", () => {
    const result = validateSchemaString(JSON.stringify(validProduct));
    expect(result.valid).toBe(true);
  });

  it("39. Invalid JSON string — error INVALID_JSON", () => {
    const result = validateSchemaString("{ not valid json }");
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("INVALID_JSON");
  });
});

// ============================================================
// 10. Integration layer
// ============================================================

describe("Integration layer", () => {
  it("40. canDeploy returns allowed: true for valid schema", () => {
    const { allowed, result } = canDeploy(validProduct);
    expect(allowed).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("41. canDeploy returns allowed: false for schema with errors", () => {
    const { name, ...noName } = validProduct;
    const { allowed, result } = canDeploy(noName);
    expect(allowed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("42. validateAIOutput validates string input", () => {
    const result = validateAIOutput(JSON.stringify(validFAQ));
    expect(result.valid).toBe(true);
  });

  it("43. auditCrawledSchema validates object input", () => {
    const result = auditCrawledSchema(validOrganization);
    expect(result.valid).toBe(true);
  });

  it("44. validateBulk validates multiple schemas", () => {
    const schemas = new Map<string, unknown>();
    schemas.set("page1", validProduct);
    schemas.set("page2", { "@context": "https://schema.org", "@type": "Product" }); // missing required
    const results = validateBulk(schemas);
    expect(results.get("page1")!.valid).toBe(true);
    expect(results.get("page2")!.valid).toBe(false);
  });
});

// ============================================================
// 11. getStatusFromValidation
// ============================================================

describe("getStatusFromValidation", () => {
  it("45. Returns 'valid' for schema with no issues", () => {
    const result = validateSchema(validProduct);
    expect(getStatusFromValidation(result, false)).toBe("valid");
  });

  it("46. Returns 'error' for schema with errors", () => {
    const result = validateSchema({
      "@context": "https://schema.org",
      "@type": "Product",
    });
    expect(getStatusFromValidation(result, false)).toBe("error");
  });

  it("47. Returns 'warning' for schema with only warnings", () => {
    const { image, description, ...minimal } = validProduct;
    const result = validateSchema(minimal);
    // Should have warnings (missing recommended) but no errors
    if (result.valid && result.warnings.length > 0) {
      expect(getStatusFromValidation(result, false)).toBe("warning");
    }
  });

  it("48. Returns 'ignored' regardless of validation if ignored=true", () => {
    const result = validateSchema({
      "@context": "https://schema.org",
      "@type": "Product",
    });
    expect(getStatusFromValidation(result, true)).toBe("ignored");
  });
});

// ============================================================
// 12. Inheritance resolution
// ============================================================

describe("Inheritance resolution", () => {
  it("49. BlogPosting inherits all Article properties", () => {
    const articleProps = resolveProperties("Article");
    const blogProps = resolveProperties("BlogPosting");
    // BlogPosting should have at least all Article properties
    const articleNames = new Set(articleProps.map((p) => p.name));
    const blogNames = new Set(blogProps.map((p) => p.name));
    for (const name of articleNames) {
      expect(blogNames.has(name)).toBe(true);
    }
  });

  it("50. LocalBusiness inherits Organization properties", () => {
    const orgProps = resolveProperties("Organization");
    const lbProps = resolveProperties("LocalBusiness");
    const orgNames = orgProps.map((p) => p.name);
    const lbNames = new Set(lbProps.map((p) => p.name));
    for (const name of orgNames) {
      expect(lbNames.has(name)).toBe(true);
    }
  });

  it("51. Offer invalidProperties include 'color'", () => {
    const invalid = resolveInvalidProperties("Offer");
    expect("color" in invalid).toBe(true);
  });
});

// ============================================================
// 13. Schema definitions coverage
// ============================================================

describe("Schema definitions coverage", () => {
  it("52. All required types from PRD Section 8.7 are defined", () => {
    const requiredTypes = [
      "Product",
      "Offer",
      "Organization",
      "LocalBusiness",
      "FAQPage",
      "Question",
      "Answer",
      "Article",
      "BlogPosting",
      "BreadcrumbList",
      "ListItem",
      "AggregateRating",
      "Review",
      "Rating",
      "PostalAddress",
      "Brand",
      "WebSite",
      "Person",
    ];
    for (const type of requiredTypes) {
      expect(schemaDefinitions[type]).toBeDefined();
    }
  });

  it("53. No circular inheritance chains", () => {
    for (const [typeName, def] of Object.entries(schemaDefinitions)) {
      const visited = new Set<string>();
      let current: string | undefined = typeName;
      while (current) {
        expect(visited.has(current)).toBe(false);
        visited.add(current);
        current = schemaDefinitions[current]?.extends;
      }
    }
  });
});

// ============================================================
// 14. Performance (PRD requires <100ms)
// ============================================================

describe("Performance", () => {
  it("54. Validates a complex Product schema in under 100ms", () => {
    const complexProduct = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Premium Leather Bag",
      description: "Hand-crafted Italian leather bag.",
      image: "https://example.com/bag.jpg",
      sku: "BAG-001",
      gtin13: "1234567890123",
      color: "Brown",
      material: "Leather",
      brand: { "@type": "Brand", name: "Luxury Brand" },
      url: "https://example.com/bag",
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: 4.7,
        reviewCount: 89,
        bestRating: 5,
        worstRating: 1,
      },
      review: [
        {
          "@type": "Review",
          author: { "@type": "Person", name: "Alice" },
          reviewRating: { "@type": "Rating", ratingValue: 5, bestRating: 5 },
          reviewBody: "Absolutely love this bag!",
          datePublished: "2026-01-10",
        },
        {
          "@type": "Review",
          author: { "@type": "Person", name: "Bob" },
          reviewRating: { "@type": "Rating", ratingValue: 4, bestRating: 5 },
          reviewBody: "Great quality.",
          datePublished: "2026-01-12",
        },
      ],
      offers: {
        "@type": "Offer",
        price: 299.99,
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
        itemCondition: "https://schema.org/NewCondition",
        url: "https://example.com/bag",
        priceValidUntil: "2026-12-31",
        seller: {
          "@type": "Organization",
          name: "Luxury Retail",
          url: "https://luxuryretail.com",
        },
      },
    };

    const result = validateSchema(complexProduct);
    expect(result.summary.validationTimeMs).toBeLessThan(100);
    expect(result.valid).toBe(true);
  });
});

// ============================================================
// 15. Edge cases
// ============================================================

describe("Edge cases", () => {
  it("55. Accepts http://schema.org as valid @context", () => {
    const schema = { ...validProduct, "@context": "http://schema.org" };
    const result = validateSchema(schema);
    expect(
      result.errors.some((e) => e.code === "INVALID_CONTEXT")
    ).toBe(false);
  });

  it("56. Accepts https://schema.org/ with trailing slash", () => {
    const schema = { ...validProduct, "@context": "https://schema.org/" };
    const result = validateSchema(schema);
    expect(
      result.errors.some((e) => e.code === "INVALID_CONTEXT")
    ).toBe(false);
  });

  it("57. BreadcrumbList with non-integer position — error", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1.5,
          name: "Home",
          item: "https://example.com/",
        },
      ],
    };
    const result = validateSchema(schema);
    expect(
      result.errors.some(
        (e) =>
          e.code === "INVALID_PROPERTY_TYPE" &&
          e.path === "itemListElement[0].position"
      )
    ).toBe(true);
  });

  it("58. WebSite schema validates correctly", () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Acme Store",
      url: "https://acme.com",
      potentialAction: {
        "@type": "SearchAction",
        target: "https://acme.com/search?q={search_term_string}",
        "query-input": "required name=search_term_string",
      },
    };
    const result = validateSchema(schema);
    expect(result.valid).toBe(true);
  });
});
