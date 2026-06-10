import { describe, it, expect } from "vitest";
import {
  SCHEMAGEN_SNIPPET_KEY,
  locateSchemaSources,
  type RenderedJsonLdBlock,
  type SourceLocatorOps,
} from "../source-locator";
import type { ShopifyAsset } from "../types";

const THEME_ID = 111222333;

// ---------------------------------------------------------------------------
// Fixtures — the garnerandtow.com pilot shape:
//  - a Liquid-heavy product JSON-LD template in snippets/ that renders BROKEN
//  - a valid @graph block emitted from a section
//  - the SchemaGen managed snippet
//  - an app/ScriptTag-injected block no theme asset emits
// ---------------------------------------------------------------------------

const PRODUCT_SCHEMA_SNIPPET = `{%- assign current_variant = product.selected_or_first_available_variant -%}
<script type="application/ld+json">
{
  "@context": "http://schema.org/",
  "@type": "Product",
  "name": {{ product.title | json }},
  "url": "{{ shop.url }}{{ product.url }}",
  "image": [
    {{ product.featured_image | image_url: width: 1024 | prepend: "https:" | json }}
  ],
  "description": {{ product.description | strip_html | json }},
  "sku": {{ current_variant.sku | json }},
  "brand": {
    "@type": "Brand",
    "name": {{ product.vendor | json }},
  },
  "offers": [
    {%- for variant in product.variants -%}
    {
      "@type": "Offer",
      "availability": "https://schema.org/InStock",
      "price": {{ variant.price | divided_by: 100.00 | json }},
      "priceCurrency": {{ cart.currency.iso_code | json }},
      "metafieldRef": "{{ variant.metafields.custom.refs }}",
    }{% unless forloop.last %},{% endunless %}
    {%- endfor -%}
  ]
}
</script>
`;

// What the snippet above actually renders on garnerandtow product pages:
// trailing commas + unescaped quotes from metafield rendering → parseError.
const BROKEN_PRODUCT_RAW = `
{
  "@context": "http://schema.org/",
  "@type": "Product",
  "name": "Heavy Duty Duffel",
  "url": "https://garnerandtow.com/products/duffel",
  "image": [
    "https://cdn.shopify.com/s/files/duffel_1024x.jpg"
  ],
  "description": "Tough ballistic nylon hauler.",
  "sku": "GT-DUF-01",
  "brand": {
    "@type": "Brand",
    "name": "Garner & Tow",
  },
  "offers": [
    {
      "@type": "Offer",
      "availability": "https://schema.org/InStock",
      "price": 129.0,
      "priceCurrency": "USD",
      "metafieldRef": "["gid://shopify/metaobject/123"]",
    }
  ]
}
`;

const SEO_GRAPH_SECTION = `<script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          {
            "@type": "ListItem",
            "position": 1,
            "name": "Home",
            "item": "{{ shop.url }}"
          },
          {
            "@type": "ListItem",
            "position": 2,
            "name": {{ product.title | json }},
            "item": "{{ shop.url }}{{ product.url }}"
          }
        ]
      },
      {
        "@type": "HowTo",
        "name": "How to choose a towing strap",
        "step": [
          { "@type": "HowToStep", "text": {{ section.settings.step_one | json }} }
        ]
      }
    ]
  }
</script>
{% schema %}
{ "name": "SEO graph", "settings": [] }
{% endschema %}
`;

// One @graph member as the extractor flattens it (re-serialized, @context injected).
const BREADCRUMB_MEMBER = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: "https://garnerandtow.com" },
    {
      "@type": "ListItem",
      position: 2,
      name: "Heavy Duty Duffel",
      item: "https://garnerandtow.com/products/duffel",
    },
  ],
};

// The SchemaGen managed snippet embeds STATIC validated JSON with renderScript's
// unicode escapes (`<` → <). Built by hand so this test doesn't couple to
// snippet.ts (concurrently under edit).
const SG_JSON = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Recovery Strap Pro",
  description: "30ft strap with <b>looped</b> ends.",
  sku: "GT-RSP-30",
};
const SG_JSON_ESCAPED = JSON.stringify(SG_JSON, null, 2).replace(/</g, "\\u003c");
const SCHEMAGEN_SNIPPET =
  "{%- comment -%}\n" +
  "  SchemaGen managed snippet - generated automatically. Do not edit by hand.\n" +
  "{%- endcomment -%}\n" +
  "{%- if template contains 'product' and product.handle == 'recovery-strap-pro' -%}\n" +
  `<script type="application/ld+json">\n${SG_JSON_ESCAPED}\n</script>\n` +
  "{%- endif -%}\n";

// Fully static WebSite block, emitted verbatim by a snippet.
const WEBSITE_JSON = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Garner & Tow",
  potentialAction: {
    "@type": "SearchAction",
    target: "https://garnerandtow.com/search?q={search_term_string}",
    "query-input": "required name=search_term_string",
  },
};
const STATIC_WEBSITE_SNIPPET = `<script type="application/ld+json">
${JSON.stringify(WEBSITE_JSON, null, 2)}
</script>
`;

// App/ScriptTag-injected block — no theme asset shares its distinctive literals.
const EXTERNAL_ORG_RAW = JSON.stringify(
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Garner & Tow",
    logo: "https://cdn.example-app.com/logo.png",
    sameAs: ["https://facebook.com/garnerandtow"],
  },
  null,
  2
);

const BASE_ASSETS: Record<string, string> = {
  "layout/theme.liquid":
    "<!doctype html><html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>",
  "snippets/product-schema.liquid": PRODUCT_SCHEMA_SNIPPET,
  "sections/seo-graph.liquid": SEO_GRAPH_SECTION,
  "snippets/static-website.liquid": STATIC_WEBSITE_SNIPPET,
  [SCHEMAGEN_SNIPPET_KEY]: SCHEMAGEN_SNIPPET,
  "assets/base.css": "body { color: red; }",
  "config/settings_data.json": "{}",
  "templates/product.json": '{ "sections": {} }',
};

function makeFakeOps(assets: Record<string, string>) {
  const fetched: string[] = [];
  let listCalls = 0;
  const ops: SourceLocatorOps = {
    async assetsList(): Promise<ShopifyAsset[]> {
      listCalls++;
      return Object.keys(assets).map((key) => ({ key }));
    },
    async assetGet(_themeId: number, key: string): Promise<ShopifyAsset> {
      fetched.push(key);
      return { key, value: assets[key] };
    },
  };
  return { ops, fetched, listCalls: () => listCalls };
}

function block(
  raw: string,
  position: number,
  parseError?: string
): RenderedJsonLdBlock {
  let parsed: unknown = null;
  if (!parseError) {
    parsed = JSON.parse(raw);
  }
  return { raw, parsed, ...(parseError ? { parseError } : {}), position };
}

async function locate(blocks: RenderedJsonLdBlock[], ops: SourceLocatorOps) {
  return locateSchemaSources({ themeId: THEME_ID, renderedBlocks: blocks, ops });
}

describe("locateSchemaSources — classification", () => {
  it("classifies a block embedded in the SchemaGen snippet as schemagen/exact (re-serialized form)", async () => {
    const { ops } = makeFakeOps(BASE_ASSETS);
    // Extractor re-serializes parsed JSON, so the raw carries a real `<`.
    const [res] = await locate([block(JSON.stringify(SG_JSON, null, 2), 0)], ops);
    expect(res.source).toBe("schemagen");
    expect(res.assetKey).toBe(SCHEMAGEN_SNIPPET_KEY);
    expect(res.confidence).toBe("exact");
  });

  it("classifies the page-source form (literal \\u003c escapes) as schemagen/exact too", async () => {
    const { ops } = makeFakeOps(BASE_ASSETS);
    const [res] = await locate([block(SG_JSON_ESCAPED, 0)], ops);
    expect(res.source).toBe("schemagen");
    expect(res.confidence).toBe("exact");
  });

  it("attributes the garnerandtow broken Product block (parseError) to the Liquid-heavy snippet", async () => {
    const { ops } = makeFakeOps(BASE_ASSETS);
    const [res] = await locate(
      [
        {
          raw: BROKEN_PRODUCT_RAW,
          parsed: null,
          parseError: "Unexpected token g in JSON",
          position: 0,
        },
      ],
      ops
    );
    expect(res.source).toBe("theme:snippets/product-schema.liquid");
    expect(res.assetKey).toBe("snippets/product-schema.liquid");
    expect(res.confidence).toBe("likely");
    expect(res.matchedBy).toContain("snippets/product-schema.liquid");
  });

  it("attributes a flattened @graph member to the emitting section", async () => {
    const { ops } = makeFakeOps(BASE_ASSETS);
    const [res] = await locate(
      [block(JSON.stringify(BREADCRUMB_MEMBER, null, 2), 0)],
      ops
    );
    expect(res.source).toBe("theme:sections/seo-graph.liquid");
    expect(res.confidence).toBe("likely");
  });

  it("classifies a fully static block as theme/exact despite whitespace differences", async () => {
    const { ops } = makeFakeOps(BASE_ASSETS);
    // Same JSON, different indentation than the asset (2- vs 4-space).
    const [res] = await locate([block(JSON.stringify(WEBSITE_JSON, null, 4), 0)], ops);
    expect(res.source).toBe("theme:snippets/static-website.liquid");
    expect(res.confidence).toBe("exact");
  });

  it("classifies a block no theme asset emits as external", async () => {
    const { ops } = makeFakeOps(BASE_ASSETS);
    const [res] = await locate([block(EXTERNAL_ORG_RAW, 0)], ops);
    expect(res.source).toBe("external");
    expect(res.assetKey).toBeUndefined();
    expect(res.confidence).toBe("none");
  });

  it("classifies every block as external when the theme has no schema emitters", async () => {
    const { ops } = makeFakeOps({
      "layout/theme.liquid": "<html><head></head><body></body></html>",
      "assets/base.css": "body {}",
    });
    const [res] = await locate([block(EXTERNAL_ORG_RAW, 0)], ops);
    expect(res.source).toBe("external");
  });

  it("returns unknown when two assets overlap the block equally (ambiguous)", async () => {
    const articleTemplate = (heading: string) => `<!-- ${heading} -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": {{ article.title | json }},
  "articleBody": {{ article.content | strip_html | json }},
  "wordCount": {{ article.content | strip_html | split: ' ' | size }}
}
</script>
`;
    const { ops } = makeFakeOps({
      "snippets/article-a.liquid": articleTemplate("a"),
      "sections/article-b.liquid": articleTemplate("b"),
    });
    const articleRaw = JSON.stringify(
      {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: "Towing 101",
        articleBody: "Long form towing advice.",
        wordCount: 4,
      },
      null,
      2
    );
    const [res] = await locate([block(articleRaw, 0)], ops);
    expect(res.source).toBe("unknown");
    expect(res.confidence).toBe("none");
    expect(res.matchedBy).toContain("ambiguous");
  });

  it("classifies several blocks of one page in a single call, preserving positions", async () => {
    const { ops } = makeFakeOps(BASE_ASSETS);
    const results = await locate(
      [
        {
          raw: BROKEN_PRODUCT_RAW,
          parsed: null,
          parseError: "Unexpected token",
          position: 0,
        },
        block(JSON.stringify(BREADCRUMB_MEMBER, null, 2), 1),
        block(EXTERNAL_ORG_RAW, 2),
      ],
      ops
    );
    expect(results.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(results.map((r) => r.source)).toEqual([
      "theme:snippets/product-schema.liquid",
      "theme:sections/seo-graph.liquid",
      "external",
    ]);
  });

  it("returns an empty result for no blocks", async () => {
    const { ops } = makeFakeOps(BASE_ASSETS);
    expect(await locate([], ops)).toEqual([]);
  });
});

describe("locateSchemaSources — asset fetching", () => {
  it("fetches only plausible emitter paths (layout/snippets/sections/templates *.liquid)", async () => {
    const { ops, fetched } = makeFakeOps(BASE_ASSETS);
    await locate([block(EXTERNAL_ORG_RAW, 0)], ops);
    expect(fetched.sort()).toEqual(
      [
        "layout/theme.liquid",
        "snippets/product-schema.liquid",
        "sections/seo-graph.liquid",
        "snippets/static-website.liquid",
        SCHEMAGEN_SNIPPET_KEY,
      ].sort()
    );
    expect(fetched).not.toContain("assets/base.css");
    expect(fetched).not.toContain("config/settings_data.json");
    expect(fetched).not.toContain("templates/product.json");
  });

  it("caches per (ops, themeId): repeated calls do not refetch", async () => {
    const { ops, fetched, listCalls } = makeFakeOps(BASE_ASSETS);
    await locate([block(EXTERNAL_ORG_RAW, 0)], ops);
    const fetchesAfterFirst = fetched.length;
    await locate([block(JSON.stringify(BREADCRUMB_MEMBER, null, 2), 0)], ops);
    expect(fetched.length).toBe(fetchesAfterFirst);
    expect(listCalls()).toBe(1);
  });

  it("a fresh ops object gets a fresh cache (refetches)", async () => {
    const first = makeFakeOps(BASE_ASSETS);
    await locate([block(EXTERNAL_ORG_RAW, 0)], first.ops);
    const second = makeFakeOps(BASE_ASSETS);
    await locate([block(EXTERNAL_ORG_RAW, 0)], second.ops);
    expect(second.listCalls()).toBe(1);
    expect(second.fetched.length).toBeGreaterThan(0);
  });
});
