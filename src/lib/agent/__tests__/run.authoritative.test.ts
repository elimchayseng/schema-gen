/**
 * Authoritative override mode (issue #23): runGoal classifies the origin of every
 * live JSON-LD block (source locator) and turns competing theme emissions into
 * suppressions, external/app blocks into merchant actions, and leaves SchemaGen's
 * own snippet alone. The locator itself is mocked — its classification mechanics
 * live in source-locator tests; here we test the PLAN runGoal builds from its
 * verdicts. No network, no Supabase, no LLM.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PageResult } from "@/lib/crawl/types";
import type { ExtractedJsonLd } from "@/lib/url-validator/types";

vi.mock("@/lib/crawl/process-page", () => ({ processPage: vi.fn() }));
vi.mock("@/lib/crawl/sitemap", () => ({ fetchSitemap: vi.fn() }));
vi.mock("../catalog", () => ({ enumerateCatalogUrls: vi.fn(async () => []) }));

// Supabase capture: the sites row getSiteRow reads (shop_domain null → env context).
const h = vi.hoisted(() => {
  const state = {
    site: { domain: "shop.com", shop_domain: null } as {
      domain: string;
      shop_domain: string | null;
    },
  };
  const client = {
    from() {
      return {
        insert() {
          return {
            select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }),
            then: (resolve: (v: { error: unknown }) => void) => resolve({ error: null }),
          };
        },
        select() {
          const builder = {
            eq: () => builder,
            single: async () => ({ data: state.site, error: null }),
            then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
          };
          return builder;
        },
        update() {
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { state, createAdminClient: vi.fn(() => client) };
});
vi.mock("@/lib/supabase", () => ({ createAdminClient: h.createAdminClient }));


// applyEntries captures the suppression plan runGoal computed; the write/rollback
// mechanics are apply.test.ts territory.
const applyMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../apply", () => ({
  applyEntries: applyMock.fn,
  makeShopifyOps: vi.fn(() => ({})),
}));

vi.mock("@/lib/shopify/config", () => ({
  getShopifyConfig: () => ({ shop: "shop.myshopify.com", apiVersion: "2025-01", baseUrl: "x" }),
  normalizeShop: (s: string) => s,
}));

vi.mock("@/lib/shopify/storefront-password", () => ({
  getStorefrontCookie: vi.fn(async () => null),
  isStorefrontPasswordConfigured: vi.fn(() => false),
  looksPasswordGated: vi.fn(() => false),
}));

const themesMock = vi.hoisted(() => ({
  prepareStagingTheme: vi.fn(),
  themePublish: vi.fn(),
  themeDelete: vi.fn(),
  themesList: vi.fn(
    async (): Promise<{ id: number; name: string; role: string }[]> => []
  ),
  // No-op: the guard's role/existence checks are unit-tested in themes.test.ts.
  assertSafeWriteTheme: vi.fn(),
}));
vi.mock("@/lib/shopify/themes", () => ({
  ...themesMock,
  MANAGED_STAGING_PREFIX: "SchemaGen Staging",
}));

vi.mock("@/lib/shopify/credentials", () => ({
  resolveShopContext: vi.fn(async () => ({
    shop: "shop.myshopify.com",
    storefrontPassword: null,
  })),
}));

// L4 verify — mocked so the makeLiveVerify closure's forwarding into l4Verify is
// observable (issue #24 gate). verifyRenderedHtml is included only so post-publish.ts
// (a transitive import of run.ts) still loads; it is never invoked here.
const verifyMock = vi.hoisted(() => ({
  l4Verify: vi.fn(),
  verifyRenderedHtml: vi.fn(),
}));
vi.mock("../verify", () => verifyMock);

// THE SOURCE LOCATOR — mocked: each test scripts the classification verdicts.
const locatorMock = vi.hoisted(() => {
  const state = { assetText: null as string | null };
  const ops = {
    assetsList: vi.fn(async () => []),
    assetGet: vi.fn(async (_themeId: number, key: string) => ({
      key,
      value: state.assetText,
    })),
  };
  return {
    state,
    ops,
    locateSchemaSources: vi.fn(),
    makeSourceLocatorOps: vi.fn(() => ops),
  };
});
vi.mock("@/lib/shopify/source-locator", () => ({
  locateSchemaSources: locatorMock.locateSchemaSources,
  makeSourceLocatorOps: locatorMock.makeSourceLocatorOps,
  // Real tokenizer (issue #37 dedup): run.ts now imports the shared regex from
  // here for pickContainsLiteral; keep the mock's value identical to the source.
  STRING_LITERAL_RE: /"(?:[^"\\\n]|\\.)*"/g,
}));

import { processPage } from "@/lib/crawl/process-page";
import { fetchSitemap } from "@/lib/crawl/sitemap";
import { runGoal } from "../run";
import type { Goal } from "../types";

const mockProcess = vi.mocked(processPage);
const mockSitemap = vi.mocked(fetchSitemap);
const locateMock = locatorMock.locateSchemaSources;

const HOME = "https://shop.com/";
const PRODUCT = "https://shop.com/products/tee";

// ---- Engine-valid fixtures (mirrors run.site-scope.test.ts) ----

const org = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Shop Co",
  url: "https://shop.com",
};
const website = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Shop Co",
  url: "https://shop.com",
};
const product = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Summer Collection Tee",
  description: "A lightweight cotton t-shirt.",
  image: "https://shop.com/tee.jpg",
  offers: {
    "@type": "Offer",
    price: 29.99,
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
};
const breadcrumb = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: "https://shop.com/" },
    { "@type": "ListItem", position: 2, name: "Tee", item: PRODUCT },
  ],
};

// The live JSON-LD blocks the perceive scan saw on the product page (per test).
let renderedBlocks: ExtractedJsonLd[] = [];

/** A parseable block declaring `type` with a long distinctive literal. */
function block(type: string): ExtractedJsonLd {
  const parsed = {
    "@context": "https://schema.org",
    "@type": type,
    name: "Legacy Product Title",
  };
  return { raw: JSON.stringify(parsed), parsed, position: 0 };
}

/** The garnerandtow case: raw garbage the extractor could not parse. */
const unparseableBlock: ExtractedJsonLd = {
  raw: '{"@type": "Product", "name": "Broken',
  parsed: null,
  parseError: "Unexpected end of JSON input",
  position: 0,
};

function scan(url: string): PageResult {
  return {
    url,
    status: "no_schema",
    originalSchemas: null,
    fixedSchemas: null,
    validationResults: null,
    renderedBlocks: url === PRODUCT ? renderedBlocks : [],
  } as unknown as PageResult;
}

/** An optimize result carrying the page type's full required set, all valid. */
function optimizeFor(url: string): PageResult {
  return {
    url,
    status: "valid",
    originalSchemas: null,
    fixedSchemas: url === HOME ? [org, website] : [product, breadcrumb],
    validationResults: { errorCount: 0, warningCount: 0, schemas: [] },
  } as unknown as PageResult;
}

const siteGoal = (authoritative?: boolean): Goal => ({
  siteId: "site-1",
  target: { scope: "site", requireTypes: [], minOutcome: "valid" },
  constraints: { allowSchemaTypeChange: false, ...(authoritative !== undefined ? { authoritative } : {}) },
  autonomy: "auto_apply",
});

const themeResult = (assetKey: string) => ({
  position: 0,
  source: `theme:${assetKey}`,
  assetKey,
  confidence: "likely" as const,
  matchedBy: "static-literal overlap (test)",
});

beforeEach(() => {
  vi.clearAllMocks();
  h.state.site = { domain: "shop.com", shop_domain: null };
  renderedBlocks = [];
  locatorMock.state.assetText = null;
  mockProcess.mockImplementation(async (url: string, mode: string) =>
    mode === "optimize" ? optimizeFor(url) : scan(url)
  );
  mockSitemap.mockResolvedValue({
    urls: [{ loc: PRODUCT }],
    source: "sitemap.xml",
  });
  locateMock.mockResolvedValue([]);
  themesMock.themesList.mockResolvedValue([]);
  applyMock.fn.mockResolvedValue({
    status: "applied",
    writeTarget: "999",
    l4: [],
    actions: [],
  });
  process.env.SHOPIFY_TEST_THEME_ID = "999";
});

const live = { dryRun: false, persistAudit: false, concurrency: 1 } as const;

describe("runGoal authoritative mode (issue #23)", () => {
  it("theme block declaring a required type → suppression with the asset's literal", async () => {
    renderedBlocks = [block("Product")]; // Product IS required on a product page
    locateMock.mockResolvedValue([themeResult("snippets/x.liquid")]);
    // The longest quoted literal of the rendered block appears verbatim in the asset.
    locatorMock.state.assetText =
      '<script type="application/ld+json">{"@type":"Product","name":"Legacy Product Title"}</script>';

    const result = await runGoal(siteGoal(), live);

    expect(applyMock.fn).toHaveBeenCalledTimes(1);
    const passed = applyMock.fn.mock.calls[0][0];
    expect(passed.suppressions).toEqual([
      {
        assetKey: "snippets/x.liquid",
        match: { contains: '"Legacy Product Title"' },
        url: PRODUCT,
      },
    ]);
    // The needle was validated against the real asset text (write-target theme).
    expect(locatorMock.ops.assetGet).toHaveBeenCalledWith(999, "snippets/x.liquid");
    expect(result.status).toBe("done");
  });

  it("external (app-injected) block → merchant_action, never a suppression", async () => {
    renderedBlocks = [block("Product")];
    locateMock.mockResolvedValue([
      { position: 0, source: "external", confidence: "none", matchedBy: "no overlap" },
    ]);

    const result = await runGoal(siteGoal(), live);

    const row = result.actions.find((a) => a.action === "merchant_action");
    expect(row?.outcome.startsWith("external_schema:")).toBe(true);
    expect(row?.outcome).toBe(`external_schema:Product:${PRODUCT}`);
    expect(applyMock.fn.mock.calls[0][0].suppressions).toBeUndefined();
  });

  it("schemagen-sourced block → ours; no suppression, no merchant row", async () => {
    renderedBlocks = [block("Product")];
    locateMock.mockResolvedValue([
      {
        position: 0,
        source: "schemagen",
        assetKey: "snippets/schemagen-jsonld.liquid",
        confidence: "exact",
        matchedBy: "managed snippet",
      },
    ]);

    const result = await runGoal(siteGoal(), live);

    expect(applyMock.fn.mock.calls[0][0].suppressions).toBeUndefined();
    expect(result.actions.some((a) => a.action === "merchant_action")).toBe(false);
  });

  it("unparseable theme-sourced block (garbage JSON) is suppressed regardless of type", async () => {
    renderedBlocks = [unparseableBlock];
    locateMock.mockResolvedValue([themeResult("sections/product-schema.liquid")]);
    locatorMock.state.assetText = '{"@type": "Product", "name": "{{ product.title }}';

    await runGoal(siteGoal(), live);

    const passed = applyMock.fn.mock.calls[0][0];
    expect(passed.suppressions).toHaveLength(1);
    expect(passed.suppressions[0]).toMatchObject({
      assetKey: "sections/product-schema.liquid",
      url: PRODUCT,
    });
    expect(typeof passed.suppressions[0].match.contains).toBe("string");
  });

  it("VALID theme block of a NON-required type is left alone (can't trip the duplicate gate)", async () => {
    // A fully valid Organization (name + url — our quality bar) that isn't
    // required on a product page: not competing, never suppressed.
    const parsed = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Legacy Shop",
      url: "https://shop.com",
    };
    renderedBlocks = [{ raw: JSON.stringify(parsed), parsed, position: 0 }];
    locateMock.mockResolvedValue([themeResult("snippets/org-schema.liquid")]);
    locatorMock.state.assetText = '{"@type":"Organization","name":"Legacy Shop"}';

    const result = await runGoal(siteGoal(), live);

    expect(applyMock.fn.mock.calls[0][0].suppressions).toBeUndefined();
    expect(result.actions.some((a) => a.action === "merchant_action")).toBe(false);
  });

  it("INVALID theme block of a NON-required type IS suppressed (authoritative owns broken markup)", async () => {
    // The dev-store case: Horizon emits an invalid ProductGroup. Not a required
    // type, but parsed-and-invalid theme markup is competing under authoritative.
    renderedBlocks = [block("Organization")]; // name only → invalid (url missing)
    locateMock.mockResolvedValue([themeResult("snippets/org-schema.liquid")]);
    locatorMock.state.assetText = '{"@type":"Organization","name":"Legacy Product Title"}';

    await runGoal(siteGoal(), live);

    expect(applyMock.fn.mock.calls[0][0].suppressions).toEqual([
      {
        assetKey: "snippets/org-schema.liquid",
        match: { contains: '"Legacy Product Title"' },
        url: PRODUCT,
      },
    ]);
  });

  it("locator needle + alsoEmittedBy: filter emissions suppress every co-emitting section", async () => {
    // Horizon-style: `{{ product | structured_data }}` — the locator supplies the
    // Liquid expression as the needle and names the co-emitting sections.
    renderedBlocks = [block("Product")];
    locateMock.mockResolvedValue([
      {
        position: 0,
        source: "theme:sections/product-information.liquid",
        assetKey: "sections/product-information.liquid",
        confidence: "likely",
        matchedBy: "structured_data filter emission (product)",
        needle: "{{ closest.product | structured_data }}",
        alsoEmittedBy: [
          {
            assetKey: "sections/featured-product.liquid",
            needle: "{{ section.settings.product | structured_data }}",
          },
        ],
      },
    ]);

    await runGoal(siteGoal(), live);

    const suppressions = applyMock.fn.mock.calls[0][0].suppressions;
    expect(suppressions).toEqual([
      {
        assetKey: "sections/featured-product.liquid",
        match: { contains: "{{ section.settings.product | structured_data }}" },
        url: PRODUCT,
      },
      {
        assetKey: "sections/product-information.liquid",
        match: { contains: "{{ closest.product | structured_data }}" },
        url: PRODUCT,
      },
    ]);
  });

  it("constraints.authoritative:false opts a site goal out — the locator never runs", async () => {
    renderedBlocks = [block("Product")];

    await runGoal(siteGoal(false), live);

    expect(locateMock).not.toHaveBeenCalled();
    expect(locatorMock.makeSourceLocatorOps).not.toHaveBeenCalled();
    expect(applyMock.fn).toHaveBeenCalledTimes(1); // the apply itself still ran
    expect(applyMock.fn.mock.calls[0][0].suppressions).toBeUndefined();
  });

  it("makeLiveVerify forwards ctx.unique into l4Verify (issue #24 duplicate gate)", async () => {
    // Today every other test mocks applyEntries with a canned result, so the real
    // makeLiveVerify closure never runs — reverting the `unique: ctx?.unique`
    // forwarding in run.ts would leave the suite green while silently disabling
    // the duplicate-prevention gate. Here the applyEntries mock invokes the verify
    // callback it received, exactly as the real apply envelope does.
    verifyMock.l4Verify.mockResolvedValue({ passed: true });
    applyMock.fn.mockImplementation(
      async (params: {
        verify: (
          url: string,
          entry: { jsonld: unknown },
          ctx?: { unique: boolean }
        ) => Promise<unknown>;
      }) => {
        const entry = { template: "product", handle: "tee", jsonld: product };
        await params.verify(PRODUCT, entry, { unique: true }); // suppressions present
        await params.verify(PRODUCT, entry); // ctx omitted (legacy path)
        return { status: "applied", writeTarget: "999", l4: [], actions: [] };
      }
    );

    const result = await runGoal(siteGoal(), live);

    expect(result.status).toBe("done");
    expect(verifyMock.l4Verify).toHaveBeenCalledTimes(2);
    // ctx {unique:true} must reach l4Verify — this IS the issue #24 gate wire.
    expect(verifyMock.l4Verify).toHaveBeenCalledWith(
      expect.objectContaining({ unique: true })
    );
    expect(verifyMock.l4Verify.mock.calls[0][0]).toMatchObject({ unique: true });
    // And it verifies the staged render, not the published theme.
    expect(verifyMock.l4Verify.mock.calls[0][0].url).toContain(
      "preview_theme_id=999"
    );
    // No ctx → unique must be falsy (defaults to false, never true).
    expect(verifyMock.l4Verify.mock.calls[1][0].unique).toBe(false);
  });

  it("dry-run early warning: external schema surfaces as a merchant action with no write", async () => {
    renderedBlocks = [block("Product")];
    locateMock.mockResolvedValue([
      { position: 0, source: "external", confidence: "none", matchedBy: "no overlap" },
    ]);
    // The published theme is the dry-run analysis reference.
    themesMock.themesList.mockResolvedValue([
      { id: 555, name: "Live Theme", role: "main" },
    ]);

    const result = await runGoal(siteGoal(), { persistAudit: false, concurrency: 1 }); // dryRun default

    expect(applyMock.fn).not.toHaveBeenCalled(); // nothing written
    const row = result.actions.find((a) => a.action === "merchant_action");
    expect(row?.outcome).toBe(`external_schema:Product:${PRODUCT}`);
    // Classification ran against the published theme.
    expect(locateMock).toHaveBeenCalledTimes(1);
    expect(locateMock.mock.calls[0][0].themeId).toBe(555);
  });
});
