/**
 * Scope "site" (issues #27/#28): full-catalog resolution with deterministic
 * page-type priority, per-page required types from the matrix, and the
 * Admin-API catalog fallback. All network surfaces (processPage, fetchSitemap,
 * the catalog enumerator, Supabase) are mocked — no live Shopify/LLM calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PageResult } from "@/lib/crawl/types";

vi.mock("@/lib/crawl/process-page", () => ({ processPage: vi.fn() }));
vi.mock("@/lib/crawl/sitemap", () => ({ fetchSitemap: vi.fn() }));
vi.mock("../catalog", () => ({ enumerateCatalogUrls: vi.fn() }));
vi.mock("@/lib/shopify/config", () => ({
  getShopifyConfig: () => ({ shop: "shop.myshopify.com", apiVersion: "2025-01", baseUrl: "x" }),
  normalizeShop: (s: string) => s,
}));

// Supabase capture: sites row for getSiteRow, agent_runs insert/update, and the
// thenable empty selects loadCommittedUrls relies on.
const h = vi.hoisted(() => {
  const state = {
    site: { domain: "shop.com", shop_domain: "shop.myshopify.com" },
    updates: [] as { table: string; payload: Record<string, unknown> }[],
  };
  const client = {
    from(table: string) {
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
        update(payload: Record<string, unknown>) {
          state.updates.push({ table, payload });
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { state, createAdminClient: vi.fn(() => client) };
});
vi.mock("@/lib/supabase", () => ({ createAdminClient: h.createAdminClient }));

import { processPage } from "@/lib/crawl/process-page";
import { fetchSitemap } from "@/lib/crawl/sitemap";
import { enumerateCatalogUrls } from "../catalog";
import { runGoal } from "../run";
import type { Goal } from "../types";

const mockProcess = vi.mocked(processPage);
const mockSitemap = vi.mocked(fetchSitemap);
const mockCatalog = vi.mocked(enumerateCatalogUrls);

const HOME = "https://shop.com/";
const PRODUCT_A = "https://shop.com/products/a";
const PRODUCT_B = "https://shop.com/products/b";
const COLLECTION = "https://shop.com/collections/sale";
const ARTICLE = "https://shop.com/blogs/news/my-post";
const PAGE = "https://shop.com/pages/about";

// ---- Engine-valid fixtures per page type ----

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
    { "@type": "ListItem", position: 2, name: "Sale", item: COLLECTION },
  ],
};
const collectionPage = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "Sale",
  description: "Discounted items.",
  url: COLLECTION,
};

function noSchema(url: string): PageResult {
  return {
    url,
    status: "no_schema",
    originalSchemas: null,
    fixedSchemas: null,
    validationResults: null,
  } as unknown as PageResult;
}

/** An optimize result carrying the page type's full required set, all valid. */
function optimizeFor(url: string): PageResult {
  const schemas =
    url === HOME
      ? [org, website]
      : url.includes("/products/")
        ? [product, breadcrumb]
        : [collectionPage, breadcrumb];
  return {
    url,
    status: "valid",
    originalSchemas: null,
    fixedSchemas: schemas,
    validationResults: { errorCount: 0, warningCount: 0, schemas: [] },
  } as unknown as PageResult;
}

const siteGoal = (maxPages?: number): Goal => ({
  siteId: "site-1",
  target: { scope: "site", requireTypes: [], minOutcome: "rich_results_eligible" },
  constraints: { maxPages, allowSchemaTypeChange: false },
  autonomy: "auto_apply",
});

beforeEach(() => {
  vi.clearAllMocks();
  h.state.updates = [];
  h.state.site = { domain: "shop.com", shop_domain: "shop.myshopify.com" };
  mockProcess.mockImplementation(async (url: string, mode: string) =>
    mode === "optimize" ? optimizeFor(url) : noSchema(url)
  );
  mockSitemap.mockResolvedValue({
    // Deliberately shuffled: priority ordering must come from the agent.
    urls: [PAGE, ARTICLE, COLLECTION, PRODUCT_B, HOME, PRODUCT_A].map((loc) => ({ loc })),
    source: "sitemap.xml",
  });
  mockCatalog.mockResolvedValue([]);
});

describe("runGoal scope 'site' (issues #27/#28)", () => {
  it("orders targets home → products → collections → articles → pages, capped by maxPages", async () => {
    const result = await runGoal(siteGoal(4), { persistAudit: true, concurrency: 1 });

    // The persisted resolved list IS the capped, priority-ordered target set.
    const resolved = h.state.updates.find(
      (u) => u.table === "agent_runs" && "resolved_urls" in u.payload
    );
    expect(resolved?.payload).toEqual({
      resolved_urls: [HOME, PRODUCT_B, PRODUCT_A, COLLECTION],
    });
    // Article + page fell outside the cap; everything inside it was satisfied.
    expect(result.satisfied).toEqual(
      expect.arrayContaining([HOME, PRODUCT_B, PRODUCT_A, COLLECTION])
    );
    expect(result.unsatisfied).toEqual([]);
    expect(result.status).toBe("done");
    expect(mockCatalog).not.toHaveBeenCalled(); // sitemap was non-empty
  });

  it("tells generation which types each page type requires (the matrix, per page)", async () => {
    await runGoal(siteGoal(4), { persistAudit: false, concurrency: 1 });

    const optimizeTypes = new Map(
      mockProcess.mock.calls
        .filter((c) => c[1] === "optimize")
        .map((c) => [c[0], (c[3] as { requiredTypes?: string[] }).requiredTypes])
    );
    expect(optimizeTypes.get(HOME)).toEqual(["Organization", "WebSite"]);
    expect(optimizeTypes.get(PRODUCT_A)).toEqual(["Product", "BreadcrumbList"]);
    expect(optimizeTypes.get(COLLECTION)).toEqual(["CollectionPage", "BreadcrumbList"]);
  });

  it("a homepage with only a valid WebSite is NOT satisfied (Organization missing)", async () => {
    mockProcess.mockImplementation(async (url: string, mode: string) => {
      if (mode === "scan" && url === HOME) {
        return {
          url,
          status: "valid",
          originalSchemas: [website],
          fixedSchemas: [website],
          validationResults: {
            errorCount: 0,
            warningCount: 0,
            schemas: [{ type: "WebSite", original: website, fixed: website, validation: { valid: true }, fixesApplied: [] }],
          },
        } as unknown as PageResult;
      }
      return mode === "optimize" ? optimizeFor(url) : noSchema(url);
    });

    const result = await runGoal(siteGoal(1), { persistAudit: false, concurrency: 1 });

    expect(result.skipped).toEqual([]); // home was queued, not skipped
    expect(mockProcess).toHaveBeenCalledWith(
      HOME,
      "optimize",
      undefined,
      expect.objectContaining({ requiredTypes: ["Organization", "WebSite"] })
    );
    expect(result.satisfied).toEqual([HOME]);
  });

  it("staged snippet guards the homepage with an exact index match", async () => {
    const result = await runGoal(siteGoal(1), { persistAudit: false, concurrency: 1 });
    expect(result.stagedSnippet).toContain("{%- if template == 'index' -%}");
  });

  it("falls back to the Admin-API catalog when the sitemap is empty", async () => {
    mockSitemap.mockResolvedValue({ urls: [], source: "none", error: "No sitemap found" });
    mockCatalog.mockResolvedValue([HOME, PRODUCT_A, COLLECTION]);

    const result = await runGoal(siteGoal(), { persistAudit: false, concurrency: 1 });

    expect(mockCatalog).toHaveBeenCalledWith("shop.com", "shop.myshopify.com");
    expect(result.satisfied).toEqual(
      expect.arrayContaining([HOME, PRODUCT_A, COLLECTION])
    );
    expect(result.status).toBe("done");
  });

  it("an empty sitemap AND no credentials resolve to zero targets (clean done, no crash)", async () => {
    mockSitemap.mockResolvedValue({ urls: [], source: "none", error: "No sitemap found" });
    mockCatalog.mockResolvedValue([]); // the gate said no

    const result = await runGoal(siteGoal(), { persistAudit: false });
    expect(result.pagesTouched).toBe(0);
    expect(result.status).toBe("done");
  });
});
