import { describe, it, expect } from "vitest";
import {
  mergeSnippetEntries,
  parseSchemaGenSnippet,
  renderSchemaGenSnippet,
  urlToTemplateTarget,
  type SnippetEntry,
} from "../snippet";

const PRODUCT_JSONLD = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Blue Widget",
  offers: {
    "@type": "Offer",
    price: "19.99",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
};

/** Raw text inside the first ld+json script block. */
function scriptBody(snippet: string): string {
  const m = snippet.match(
    /<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/
  );
  if (!m) throw new Error("no ld+json script found");
  return m[1];
}

/** Parse the embedded JSON-LD. The \uXXXX escapes are valid JSON, so JSON.parse restores them. */
function extractJsonLd(snippet: string): unknown {
  return JSON.parse(scriptBody(snippet));
}

describe("renderSchemaGenSnippet", () => {
  it("renders a product entry with correct, parseable JSON-LD", () => {
    const entries: SnippetEntry[] = [
      { template: "product", handle: "blue-widget", jsonld: PRODUCT_JSONLD },
    ];
    const out = renderSchemaGenSnippet(entries);

    expect(out).toContain(
      "{%- if template contains 'product' and product.handle == 'blue-widget' -%}"
    );
    expect(extractJsonLd(out)).toEqual(PRODUCT_JSONLD);
  });

  it("omits the handle clause when no handle is given", () => {
    const out = renderSchemaGenSnippet([
      { template: "blog", jsonld: { "@type": "Blog" } },
    ]);
    expect(out).toContain("{%- if template contains 'blog' -%}");
    expect(out).not.toContain(".handle ==");
  });

  it("guards the homepage with an exact template match (issue #28)", () => {
    const out = renderSchemaGenSnippet([
      { template: "index", jsonld: { "@type": "WebSite" } },
    ]);
    expect(out).toContain("{%- if template == 'index' -%}");
    expect(out).not.toContain(".handle ==");
  });

  it("guards collection / article / page entries by template + handle (issue #28)", () => {
    const out = renderSchemaGenSnippet([
      { template: "collection", handle: "sale", jsonld: { "@type": "CollectionPage" } },
      { template: "article", handle: "news/my-post", jsonld: { "@type": "BlogPosting" } },
      { template: "page", handle: "about", jsonld: { "@type": "WebPage" } },
    ]);
    expect(out).toContain(
      "{%- if template contains 'collection' and collection.handle == 'sale' -%}"
    );
    // article.handle in Liquid is "<blog>/<article>" — the guard carries both halves.
    expect(out).toContain(
      "{%- if template contains 'article' and article.handle == 'news/my-post' -%}"
    );
    expect(out).toContain(
      "{%- if template contains 'page' and page.handle == 'about' -%}"
    );
  });

  it("the two-part handle form is article-only (no slash elsewhere)", () => {
    expect(() =>
      renderSchemaGenSnippet([
        { template: "product", handle: "news/my-post", jsonld: {} },
      ])
    ).toThrow(/Invalid Shopify handle/);
    expect(() =>
      renderSchemaGenSnippet([
        { template: "article", handle: "a/b/c", jsonld: {} },
      ])
    ).toThrow(/Invalid Shopify handle/);
  });

  it("escapes < so a string can't break out of the <script> tag", () => {
    const out = renderSchemaGenSnippet([
      { template: "page", handle: "x", jsonld: { evil: "</script><x>" } },
    ]);
    const body = scriptBody(out);
    expect(body).not.toContain("</script>");
    expect(body).toContain("\\u003c");
    expect(extractJsonLd(out)).toEqual({ evil: "</script><x>" });
  });

  it("neutralizes Liquid so a payload value can't inject template code", () => {
    // The classic {% raw %} breakout + server-side template injection attempt.
    const evil = { note: "{% endraw %}{{ shop.metafields.secret }}{% raw %}" };
    const out = renderSchemaGenSnippet([
      { template: "page", handle: "x", jsonld: evil },
    ]);
    const body = scriptBody(out);
    // no live Liquid openers survive in the payload
    expect(body).not.toContain("{{");
    expect(body).not.toContain("{%");
    // and the data still round-trips intact
    expect(extractJsonLd(out)).toEqual(evil);
  });

  it("rejects an invalid handle rather than emitting unsafe Liquid", () => {
    expect(() =>
      renderSchemaGenSnippet([
        { template: "product", handle: "x' or template contains 'cart", jsonld: {} },
      ])
    ).toThrow(/Invalid Shopify handle/);
  });

  it("rejects an invalid template", () => {
    expect(() =>
      renderSchemaGenSnippet([{ template: "{% evil %}", jsonld: {} }])
    ).toThrow(/Invalid Shopify template/);
  });

  it("renders one guarded block per entry", () => {
    const out = renderSchemaGenSnippet([
      { template: "product", handle: "a", jsonld: {} },
      { template: "product", handle: "b", jsonld: {} },
    ]);
    expect(out.match(/{%- if /g)).toHaveLength(2);
    expect(out.match(/{%- endif -%}/g)).toHaveLength(2);
  });

  it("returns only the managed header for no entries", () => {
    const out = renderSchemaGenSnippet([]);
    expect(out).toContain("SchemaGen managed snippet");
    expect(out).not.toContain("{%- if");
  });
});

describe("parseSchemaGenSnippet / mergeSnippetEntries (subset-run preservation)", () => {
  const skiWax: SnippetEntry = {
    template: "product",
    handle: "ski-wax",
    jsonld: { ...PRODUCT_JSONLD, name: "Ski Wax" },
  };
  const snowboard: SnippetEntry = {
    template: "product",
    handle: "snowboard",
    jsonld: { ...PRODUCT_JSONLD, name: "Snowboard" },
  };
  const home: SnippetEntry = {
    template: "index",
    jsonld: { "@context": "https://schema.org", "@type": "WebSite", name: "Shop" },
  };

  it("round-trips: parse(render(entries)) === entries", () => {
    const rendered = renderSchemaGenSnippet([skiWax, snowboard, home]);
    expect(parseSchemaGenSnippet(rendered)).toEqual([skiWax, snowboard, home]);
  });

  it("round-trips payloads containing escaped breakout characters", () => {
    const tricky: SnippetEntry = {
      template: "product",
      handle: "tricky",
      jsonld: { ...PRODUCT_JSONLD, description: "uses </script> and {% raw %} and {{ shop }}" },
    };
    const roundTripped = parseSchemaGenSnippet(renderSchemaGenSnippet([tricky]));
    expect(roundTripped).toEqual([tricky]);
    // And re-rendering the parsed entries is byte-identical (stable re-runs).
    expect(renderSchemaGenSnippet(roundTripped)).toBe(renderSchemaGenSnippet([tricky]));
  });

  it("returns [] for a file that is not a SchemaGen-managed snippet", () => {
    expect(parseSchemaGenSnippet("{% comment %} someone else's snippet {% endcomment %}")).toEqual([]);
    expect(parseSchemaGenSnippet("")).toEqual([]);
  });

  it("merge: an incoming entry replaces the existing entry for the same page", () => {
    const updated = { ...skiWax, jsonld: { ...PRODUCT_JSONLD, name: "Ski Wax v2" } };
    expect(mergeSnippetEntries([skiWax, snowboard], [updated])).toEqual([updated, snowboard]);
  });

  it("merge: entries for pages not in this run are preserved (the live regression)", () => {
    // A run scoped to ski-wax only must not delete snowboard's schema.
    const merged = mergeSnippetEntries([skiWax, snowboard, home], [skiWax]);
    expect(merged).toEqual([skiWax, snowboard, home]);
  });

  it("merge: new pages append after existing ones", () => {
    expect(mergeSnippetEntries([skiWax], [snowboard, home])).toEqual([skiWax, snowboard, home]);
  });

  it("merge distinguishes same template with different handles and no-handle entries", () => {
    const allProducts: SnippetEntry = { template: "product", jsonld: { "@type": "ItemList" } };
    const merged = mergeSnippetEntries([skiWax, allProducts], [{ ...allProducts, jsonld: { "@type": "ItemList", name: "x" } }]);
    expect(merged[0]).toEqual(skiWax);
    expect((merged[1].jsonld as { name?: string }).name).toBe("x");
  });
});

describe("urlToTemplateTarget", () => {
  it.each([
    ["https://shop.com/products/blue-widget", { template: "product", handle: "blue-widget" }],
    ["https://shop.com/collections/sale", { template: "collection", handle: "sale" }],
    ["https://shop.com/collections/sale/products/blue-widget", { template: "product", handle: "blue-widget" }],
    ["https://shop.com/pages/about", { template: "page", handle: "about" }],
    // article.handle in Liquid is "<blog>/<article>", so the target carries both.
    ["https://shop.com/blogs/news/my-post", { template: "article", handle: "news/my-post" }],
    ["https://shop.com/", { template: "index" }],
    ["https://shop.com", { template: "index" }],
  ])("maps %s", (url, expected) => {
    expect(urlToTemplateTarget(url)).toEqual(expected);
  });

  it("returns null for unknown paths", () => {
    expect(urlToTemplateTarget("https://shop.com/cart")).toBeNull();
  });

  it("accepts a bare path", () => {
    expect(urlToTemplateTarget("/products/x")).toEqual({
      template: "product",
      handle: "x",
    });
  });
});
