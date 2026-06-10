import { describe, it, expect } from "vitest";
import { extractJsonLd } from "../extractor";

const script = (json: unknown) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(json)}</script></head></html>`;

const types = (html: string) =>
  extractJsonLd(html)
    .filter((b) => !b.parseError && b.parsed !== null)
    .map((b) => (b.parsed as Record<string, unknown>)["@type"]);

describe("extractJsonLd", () => {
  it("returns a single schema object as one block", () => {
    const html = script({ "@context": "https://schema.org", "@type": "Product", name: "Tee" });
    const blocks = extractJsonLd(html);
    expect(blocks).toHaveLength(1);
    expect((blocks[0].parsed as Record<string, unknown>)["@type"]).toBe("Product");
  });

  it("flattens a top-level array of schemas (Shopify/SchemaGen emit [Organization, Product])", () => {
    // This is the regression that made L4 reject SchemaGen's OWN output: the injected
    // snippet writes a single <script> with a top-level array, and the unflattened array
    // was treated as one typeless schema, hiding the Product from validation.
    const html = script([
      { "@context": "https://schema.org", "@type": "Organization", name: "Acme" },
      { "@context": "https://schema.org", "@type": "Product", name: "Snowboard" },
    ]);
    expect(types(html)).toEqual(["Organization", "Product"]);
  });

  it("expands @graph wrappers", () => {
    const html = script({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Site" },
        { "@type": "Product", name: "Thing" },
      ],
    });
    expect(types(html)).toEqual(["WebSite", "Product"]);
  });

  it("expands @graph nested inside a top-level array", () => {
    const html = script([
      { "@type": "BreadcrumbList" },
      { "@context": "https://schema.org", "@graph": [{ "@type": "Product", name: "X" }] },
    ]);
    expect(types(html)).toEqual(["BreadcrumbList", "Product"]);
  });

  it("records a parse error for invalid JSON without throwing", () => {
    const html = `<script type="application/ld+json">{ not json }</script>`;
    const blocks = extractJsonLd(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parseError).toBeTruthy();
    expect(blocks[0].parsed).toBeNull();
  });
});
