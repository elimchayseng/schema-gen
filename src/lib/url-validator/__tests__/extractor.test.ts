import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractJsonLd } from "../extractor";
import { validateSchema } from "@/lib/validation/engine";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");

const script = (json: unknown) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(json)}</script></head></html>`;

const scriptRaw = (text: string) =>
  `<html><head><script type="application/ld+json">${text}</script></head></html>`;

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

  it("skips empty/whitespace-only blocks instead of reporting a parse error", () => {
    const html = `<script type="application/ld+json">   </script>`;
    expect(extractJsonLd(html)).toHaveLength(0);
  });
});

// ============================================================
// Issue #19 — @context propagation onto @graph members
// ============================================================

describe("extractJsonLd @context propagation (issue #19)", () => {
  it("propagates the wrapper @context onto @graph members that lack their own", () => {
    const html = script({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Site", url: "https://x.com" },
        { "@type": "BreadcrumbList", itemListElement: [] },
      ],
    });
    const blocks = extractJsonLd(html);
    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      expect((b.parsed as Record<string, unknown>)["@context"]).toBe(
        "https://schema.org"
      );
      // The re-stringified raw must carry the context too (it is what gets displayed/staged)
      expect(b.raw).toContain('"@context"');
    }
  });

  it("does not overwrite a member's own @context", () => {
    const html = script({
      "@context": "https://schema.org",
      "@graph": [{ "@context": "http://schema.org", "@type": "WebSite", name: "S" }],
    });
    const blocks = extractJsonLd(html);
    expect((blocks[0].parsed as Record<string, unknown>)["@context"]).toBe(
      "http://schema.org"
    );
  });

  it("propagates @context for @graph wrappers nested in a top-level array", () => {
    const html = script([
      { "@context": "https://schema.org", "@graph": [{ "@type": "Product", name: "X" }] },
    ]);
    const blocks = extractJsonLd(html);
    expect((blocks[0].parsed as Record<string, unknown>)["@context"]).toBe(
      "https://schema.org"
    );
  });

  it("real garnerandtow @graph: BreadcrumbList, HowTo, Product all inherit the parent @context and validate without MISSING_CONTEXT", () => {
    const html = scriptRaw(fixture("garnerandtow-duffel-graph.jsonld.txt"));
    const blocks = extractJsonLd(html);
    expect(types(html)).toEqual(["BreadcrumbList", "HowTo", "Product"]);
    for (const b of blocks) {
      const parsed = b.parsed as Record<string, unknown>;
      expect(parsed["@context"]).toBe("https://schema.org");
      const result = validateSchema(parsed);
      expect(
        result.errors.some(
          (e) => e.code === "MISSING_CONTEXT" || e.code === "INVALID_CONTEXT"
        )
      ).toBe(false);
    }
    // The BreadcrumbList and HowTo members are fully valid once context is inherited.
    const byType = (t: string) =>
      blocks.find((b) => (b.parsed as Record<string, unknown>)["@type"] === t)!;
    expect(validateSchema(byType("BreadcrumbList").parsed).valid).toBe(true);
    expect(validateSchema(byType("HowTo").parsed).valid).toBe(true);
    // The @graph Product has aggregateRating + review but no offers — valid under
    // Google's one-of rule (issue #21), instead of falsely failing on offers.
    expect(validateSchema(byType("Product").parsed).valid).toBe(true);
  });
});

// ============================================================
// Issue #20 — robust extraction of real-world script tags
// ============================================================

describe("extractJsonLd robustness (issue #20)", () => {
  const product = { "@context": "https://schema.org", "@type": "Product", name: "Tee" };

  it("decodes HTML entities when the raw parse fails", () => {
    const encoded = JSON.stringify(product)
      .replace(/"/g, "&quot;")
      .replace(/&quot;Tee&quot;/, "&quot;Tee &amp; Co&#39;s&quot;");
    const blocks = extractJsonLd(scriptRaw(encoded));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parseError).toBeUndefined();
    expect((blocks[0].parsed as Record<string, unknown>).name).toBe("Tee & Co's");
  });

  it("strips CDATA wrappers", () => {
    const blocks = extractJsonLd(
      scriptRaw(`/*<![CDATA[*/ ${JSON.stringify(product)} /*]]>*/`)
    );
    expect(blocks).toHaveLength(1);
    expect((blocks[0].parsed as Record<string, unknown>)["@type"]).toBe("Product");
  });

  it("strips HTML comment wrappers", () => {
    const blocks = extractJsonLd(scriptRaw(`<!-- ${JSON.stringify(product)} -->`));
    expect(blocks).toHaveLength(1);
    expect((blocks[0].parsed as Record<string, unknown>)["@type"]).toBe("Product");
  });

  it("tolerates trailing commas", () => {
    const blocks = extractJsonLd(
      scriptRaw(`{"@context": "https://schema.org", "@type": "Product", "name": "Tee",}`)
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parseError).toBeUndefined();
    expect((blocks[0].parsed as Record<string, unknown>).name).toBe("Tee");
  });

  it("does not strip a literal ', }' inside a string value", () => {
    const blocks = extractJsonLd(
      scriptRaw(`{"@type": "Product", "name": "Weird, }", "sku": "A",}`)
    );
    expect((blocks[0].parsed as Record<string, unknown>).name).toBe("Weird, }");
  });

  it("repairs the Shopify metaobject unescaped-quote pattern", () => {
    const broken = `{"@context":"https://schema.org","@type":"Product","name":"Duffel","additionalProperty":[{"@type":"PropertyValue","name":"Feature","value":"["gid://shopify/metaobject/138511941771"]"}]}`;
    const blocks = extractJsonLd(scriptRaw(broken));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parseError).toBeUndefined();
    const parsed = blocks[0].parsed as Record<string, unknown>;
    expect(parsed["@type"]).toBe("Product");
    const prop = (parsed.additionalProperty as Record<string, unknown>[])[0];
    expect(prop.value).toBe('["gid://shopify/metaobject/138511941771"]');
  });

  it("rejects a quote 'repair' whose result is not JSON-LD shaped", () => {
    // Parses after repair but contains no @type/@graph/@context — must stay a parse error.
    const blocks = extractJsonLd(scriptRaw(`{"a": "["b"]"}`));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parseError).toBeTruthy();
    expect(blocks[0].parsed).toBeNull();
  });

  it("returns still-unparseable blocks as structured results, never dropping them", () => {
    const html = `${scriptRaw("{ totally broken")}${script(product)}`;
    const blocks = extractJsonLd(html);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].parseError).toBeTruthy();
    expect(blocks[0].raw).toContain("totally broken");
    expect((blocks[1].parsed as Record<string, unknown>)["@type"]).toBe("Product");
  });

  it("real garnerandtow broken theme Product: repaired, parsed, and recognized as a Product", () => {
    const html = scriptRaw(fixture("garnerandtow-duffel-broken-product.jsonld.txt"));
    const blocks = extractJsonLd(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].parseError).toBeUndefined();
    const parsed = blocks[0].parsed as Record<string, unknown>;
    expect(parsed["@type"]).toBe("Product");
    expect(parsed.name).toBe("Duffel");
    // The multi-gid metaobject values are repaired intact
    const props = parsed.additionalProperty as Record<string, unknown>[];
    expect(props).toHaveLength(3);
    expect(props[1].value).toBe(
      '["gid://shopify/metaobject/99113631883","gid://shopify/metaobject/138512007307"]'
    );
    // The offer survives the repair
    const offers = parsed.offers as Record<string, unknown>;
    expect(offers.price).toBe("300.00");
  });

  it("full garnerandtow duffel page fixture: both blocks extracted — repaired theme Product plus three @graph members", () => {
    const blocks = extractJsonLd(fixture("garnerandtow-duffel.html"));
    const typeList = blocks
      .filter((b) => !b.parseError)
      .map((b) => (b.parsed as Record<string, unknown>)["@type"]);
    expect(typeList).toEqual(["Product", "BreadcrumbList", "HowTo", "Product"]);
    // Nothing was silently dropped: every block is either parsed or a structured error.
    expect(blocks.every((b) => b.parsed !== null || b.parseError)).toBe(true);
  });
});
