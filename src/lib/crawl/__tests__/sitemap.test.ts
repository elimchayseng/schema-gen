import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseSitemapXml,
  isSitemapIndex,
  fetchSitemap,
  filterSitemapUrls,
} from "../sitemap";

describe("parseSitemapXml", () => {
  it("parses a standard sitemap with urlset", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/</loc></url>
        <url><loc>https://example.com/about</loc><lastmod>2026-01-01</lastmod></url>
        <url><loc>https://example.com/products/tee</loc></url>
      </urlset>`;

    const urls = parseSitemapXml(xml);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toEqual({ loc: "https://example.com/" });
    expect(urls[1]).toEqual({
      loc: "https://example.com/about",
      lastmod: "2026-01-01",
    });
    expect(urls[2]).toEqual({ loc: "https://example.com/products/tee" });
  });

  it("parses a sitemap index with child sitemap references", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/sitemap-products.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
      </sitemapindex>`;

    const urls = parseSitemapXml(xml);
    expect(urls).toHaveLength(2);
    expect(urls[0].loc).toBe("https://example.com/sitemap-products.xml");
    expect(urls[1].loc).toBe("https://example.com/sitemap-pages.xml");
  });

  it("returns empty array for malformed XML", () => {
    const urls = parseSitemapXml("this is not xml <<>>");
    expect(urls).toEqual([]);
  });

  it("returns empty array for empty XML", () => {
    const urls = parseSitemapXml("");
    expect(urls).toEqual([]);
  });

  it("ignores URLs with empty loc elements", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/valid</loc></url>
        <url><loc></loc></url>
        <url><loc>   </loc></url>
      </urlset>`;

    const urls = parseSitemapXml(xml);
    expect(urls).toHaveLength(1);
    expect(urls[0].loc).toBe("https://example.com/valid");
  });

  it("handles XML with no url elements", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      </urlset>`;

    const urls = parseSitemapXml(xml);
    expect(urls).toEqual([]);
  });
});

describe("filterSitemapUrls", () => {
  const locs = (urls: { loc: string }[]) => urls.map((u) => u.loc);

  it("keeps real content pages (products, collections, pages, blogs)", () => {
    const input = [
      { loc: "https://shop.com/products/tee" },
      { loc: "https://shop.com/collections/summer" },
      { loc: "https://shop.com/pages/about" },
      { loc: "https://shop.com/blogs/news/launch" },
      { loc: "https://shop.com/" },
    ];
    expect(filterSitemapUrls(input)).toEqual(input);
  });

  it("drops admin / cart / account / checkout / policies / search paths", () => {
    const input = [
      { loc: "https://shop.com/products/keep" },
      { loc: "https://shop.com/cart" },
      { loc: "https://shop.com/account/login" },
      { loc: "https://shop.com/checkout" },
      { loc: "https://shop.com/admin/themes" },
      { loc: "https://shop.com/policies/refund-policy" },
      { loc: "https://shop.com/search?q=hat" },
    ];
    expect(locs(filterSitemapUrls(input))).toEqual([
      "https://shop.com/products/keep",
    ]);
  });

  it("drops the collection-scoped duplicate of a product (canonical is /products/x)", () => {
    const input = [
      { loc: "https://shop.com/products/tee" },
      { loc: "https://shop.com/collections/summer/products/tee" },
    ];
    expect(locs(filterSitemapUrls(input))).toEqual([
      "https://shop.com/products/tee",
    ]);
  });

  it("drops feed/asset extensions and pagination/utm query URLs", () => {
    const input = [
      { loc: "https://shop.com/products/a" },
      { loc: "https://shop.com/blogs/news.atom" },
      { loc: "https://shop.com/sitemap_products_1.xml" },
      { loc: "https://shop.com/collections/all?page=2" },
      { loc: "https://shop.com/products/b?variant=123" },
      { loc: "https://shop.com/products/c?utm_source=email" },
    ];
    expect(locs(filterSitemapUrls(input))).toEqual([
      "https://shop.com/products/a",
    ]);
  });

  it("de-duplicates on normalized loc (trailing slash + query ignored)", () => {
    const input = [
      { loc: "https://shop.com/products/tee" },
      { loc: "https://shop.com/products/tee/" },
      { loc: "https://SHOP.com/products/tee" },
    ];
    expect(filterSitemapUrls(input)).toHaveLength(1);
  });

  it("drops unparseable locs and preserves order + lastmod of survivors", () => {
    const input = [
      { loc: "not a url" },
      { loc: "https://shop.com/products/a", lastmod: "2026-01-01" },
      { loc: "https://shop.com/products/b" },
    ];
    expect(filterSitemapUrls(input)).toEqual([
      { loc: "https://shop.com/products/a", lastmod: "2026-01-01" },
      { loc: "https://shop.com/products/b" },
    ]);
  });
});

describe("isSitemapIndex", () => {
  it("returns true for sitemap index format", () => {
    const xml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/sitemap1.xml</loc></sitemap>
    </sitemapindex>`;
    expect(isSitemapIndex(xml)).toBe(true);
  });

  it("returns false for standard urlset", () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/</loc></url>
    </urlset>`;
    expect(isSitemapIndex(xml)).toBe(false);
  });

  it("returns false for invalid XML", () => {
    expect(isSitemapIndex("not xml")).toBe(false);
  });
});

describe("fetchSitemap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and parses sitemap.xml from domain", async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/</loc></url>
        <url><loc>https://example.com/about</loc></url>
      </urlset>`;

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sitemapXml, { status: 200 })
    );

    const result = await fetchSitemap("example.com");
    expect(result.urls).toHaveLength(2);
    expect(result.source).toBe("sitemap.xml");
    expect(result.error).toBeUndefined();
  });

  it("returns empty with error when no sitemap found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404 })
    );

    const result = await fetchSitemap("example.com");
    expect(result.urls).toHaveLength(0);
    expect(result.source).toBe("none");
    expect(result.error).toBe("No sitemap found");
  });

  it("caps URLs at 100", async () => {
    const urls = Array.from(
      { length: 150 },
      (_, i) => `<url><loc>https://example.com/page-${i}</loc></url>`
    ).join("");
    const sitemapXml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sitemapXml, { status: 200 })
    );

    const result = await fetchSitemap("example.com");
    expect(result.urls).toHaveLength(100);
  });

  it("handles domains with https:// prefix", async () => {
    const sitemapXml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/</loc></url>
    </urlset>`;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(sitemapXml, { status: 200 })
    );

    await fetchSitemap("https://example.com");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com/sitemap.xml",
      expect.any(Object)
    );
  });

  it("falls back to robots.txt when sitemap.xml 404s", async () => {
    const robotsTxt = "User-agent: *\nSitemap: https://example.com/my-sitemap.xml\n";
    const sitemapXml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/found</loc></url>
    </urlset>`;

    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      callCount++;
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/sitemap.xml") && callCount === 1) {
        return new Response("Not Found", { status: 404 });
      }
      if (url.endsWith("/robots.txt")) {
        return new Response(robotsTxt, { status: 200 });
      }
      if (url.endsWith("/my-sitemap.xml")) {
        return new Response(sitemapXml, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await fetchSitemap("example.com");
    expect(result.urls).toHaveLength(1);
    expect(result.source).toBe("robots.txt");
  });

  it("handles fetch timeout/network errors gracefully", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    const result = await fetchSitemap("example.com");
    expect(result.urls).toHaveLength(0);
    expect(result.source).toBe("none");
  });

  it("handles sitemap index by fetching child sitemaps", async () => {
    const indexXml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
      <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
    </sitemapindex>`;

    const child1 = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/a</loc></url>
    </urlset>`;

    const child2 = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/b</loc></url>
    </urlset>`;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/sitemap.xml")) return new Response(indexXml, { status: 200 });
      if (url.includes("sitemap-1")) return new Response(child1, { status: 200 });
      if (url.includes("sitemap-2")) return new Response(child2, { status: 200 });
      return new Response("Not Found", { status: 404 });
    });

    const result = await fetchSitemap("example.com");
    expect(result.urls).toHaveLength(2);
    expect(result.source).toBe("sitemap_index");
    expect(result.urls[0].loc).toBe("https://example.com/a");
    expect(result.urls[1].loc).toBe("https://example.com/b");
  });
});
