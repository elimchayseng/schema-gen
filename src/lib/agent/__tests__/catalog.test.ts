import { describe, it, expect, vi, beforeEach } from "vitest";

// All Shopify I/O is mocked — no live Admin API calls in unit tests.
vi.mock("@/lib/shopify/client", () => ({ shopifyFetch: vi.fn() }));
vi.mock("@/lib/shopify/credentials", () => ({ resolveShopContext: vi.fn() }));

import { shopifyFetch } from "@/lib/shopify/client";
import { resolveShopContext } from "@/lib/shopify/credentials";
import { enumerateCatalogUrls } from "../catalog";

const mockFetch = vi.mocked(shopifyFetch);
const mockResolve = vi.mocked(resolveShopContext);

const ctx = {
  shop: "garnerandtow.myshopify.com",
  credentials: { appKey: "k", appSecret: "s" },
  storefrontPassword: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockResolvedValue(ctx);
});

describe("enumerateCatalogUrls", () => {
  it("builds public-domain URLs: home, then products, then collections", async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === "/products.json") {
        return { products: [{ id: 1, handle: "tow-strap" }, { id: 2, handle: "winch" }] };
      }
      if (path === "/custom_collections.json") {
        return { custom_collections: [{ id: 10, handle: "featured" }] };
      }
      return { smart_collections: [{ id: 20, handle: "new-arrivals" }] };
    });

    const urls = await enumerateCatalogUrls("garnerandtow.com", "garnerandtow.myshopify.com");

    expect(mockResolve).toHaveBeenCalledWith("garnerandtow.myshopify.com");
    expect(urls).toEqual([
      "https://garnerandtow.com/",
      "https://garnerandtow.com/products/tow-strap",
      "https://garnerandtow.com/products/winch",
      "https://garnerandtow.com/collections/featured",
      "https://garnerandtow.com/collections/new-arrivals",
    ]);
    // Every Admin call carries the per-shop context (issue #25 pattern).
    for (const call of mockFetch.mock.calls) {
      expect((call[1] as { shopContext: unknown }).shopContext).toBe(ctx);
    }
  });

  it("paginates products via since_id until a short page", async () => {
    const pageOne = Array.from({ length: 250 }, (_, i) => ({
      id: i + 1,
      handle: `p${i + 1}`,
    }));
    mockFetch.mockImplementation(async (path: string, opts) => {
      if (path === "/products.json") {
        const since = Number((opts as { query: { since_id: string } }).query.since_id);
        return { products: since === 0 ? pageOne : [{ id: 251, handle: "p251" }] };
      }
      return { custom_collections: [], smart_collections: [] };
    });

    const urls = await enumerateCatalogUrls("shop.com", "shop.myshopify.com");
    expect(urls).toHaveLength(1 + 251); // home + 251 products
    expect(urls[251]).toBe("https://shop.com/products/p251");
    // products.json hit twice: full page, then the short page after since_id=250.
    const productCalls = mockFetch.mock.calls.filter((c) => c[0] === "/products.json");
    expect(productCalls).toHaveLength(2);
    expect((productCalls[1][1] as { query: { since_id: string } }).query.since_id).toBe("250");
  });

  it("returns [] when credentials do not resolve (the gate)", async () => {
    mockResolve.mockRejectedValue(new Error("No Shopify credentials"));
    expect(await enumerateCatalogUrls("public-site.com", null)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to the public domain when the site has no shop_domain mapping", async () => {
    mockFetch.mockResolvedValue({ products: [], custom_collections: [], smart_collections: [] });
    await enumerateCatalogUrls("shop.com", null);
    expect(mockResolve).toHaveBeenCalledWith("shop.com");
  });

  it("returns [] when an Admin call fails (best-effort by contract)", async () => {
    mockFetch.mockRejectedValue(new Error("401 unauthorized"));
    expect(await enumerateCatalogUrls("shop.com", "shop.myshopify.com")).toEqual([]);
  });
});
