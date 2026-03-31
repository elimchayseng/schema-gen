import * as cheerio from "cheerio";
import type { SitemapResult, SitemapUrl } from "./types";

const MAX_URLS = 100;
const FETCH_TIMEOUT = 10_000;

/**
 * Fetch and parse a sitemap for a given domain.
 * Tries: /sitemap.xml → robots.txt sitemap reference → /sitemap_index.xml
 * Returns up to MAX_URLS URLs.
 */
export async function fetchSitemap(domain: string): Promise<SitemapResult> {
  const base = domain.startsWith("http") ? domain : `https://${domain}`;
  const baseUrl = new URL(base).origin;

  // Try 1: /sitemap.xml
  const directResult = await tryFetchSitemap(`${baseUrl}/sitemap.xml`);
  if (directResult.urls.length > 0) {
    return { ...directResult, source: directResult.source === "sitemap_index" ? "sitemap_index" : "sitemap.xml" };
  }

  // Try 2: robots.txt
  const robotsResult = await tryRobotsTxt(baseUrl);
  if (robotsResult.urls.length > 0) {
    return { ...robotsResult, source: "robots.txt" };
  }

  // Try 3: /sitemap_index.xml
  const indexResult = await tryFetchSitemap(`${baseUrl}/sitemap_index.xml`);
  if (indexResult.urls.length > 0) {
    return { ...indexResult, source: "sitemap_index" };
  }

  return { urls: [], source: "none", error: "No sitemap found" };
}

/**
 * Parse sitemap XML into an array of URLs.
 * Handles both <urlset> (standard) and <sitemapindex> (index) formats.
 */
export function parseSitemapXml(xml: string): SitemapUrl[] {
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(xml, { xmlMode: true });
  } catch {
    return [];
  }

  // Check for sitemap index
  const sitemapLocs = $("sitemapindex > sitemap > loc");
  if (sitemapLocs.length > 0) {
    // Return the sitemap URLs themselves (caller will fetch each)
    const urls: SitemapUrl[] = [];
    sitemapLocs.each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) urls.push({ loc });
    });
    return urls;
  }

  // Standard urlset
  const urls: SitemapUrl[] = [];
  $("urlset > url").each((_, el) => {
    const loc = $(el).find("loc").text().trim();
    if (loc) {
      const lastmod = $(el).find("lastmod").text().trim() || undefined;
      urls.push({ loc, lastmod });
    }
  });

  return urls;
}

/**
 * Determine if parsed XML is a sitemap index (contains child sitemap refs).
 */
export function isSitemapIndex(xml: string): boolean {
  try {
    const $ = cheerio.load(xml, { xmlMode: true });
    return $("sitemapindex > sitemap > loc").length > 0;
  } catch {
    return false;
  }
}

async function tryFetchSitemap(url: string): Promise<SitemapResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "SchemaGen/1.0 (sitemap crawler)" },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { urls: [], source: "none" };
    }

    const xml = await res.text();

    if (isSitemapIndex(xml)) {
      // Fetch each child sitemap and collect URLs
      const childUrls = parseSitemapXml(xml);
      const allUrls: SitemapUrl[] = [];

      for (const child of childUrls) {
        if (allUrls.length >= MAX_URLS) break;
        try {
          const childRes = await fetch(child.loc, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT),
            headers: { "User-Agent": "SchemaGen/1.0 (sitemap crawler)" },
          });
          if (childRes.ok) {
            const childXml = await childRes.text();
            const parsed = parseSitemapXml(childXml);
            for (const u of parsed) {
              if (allUrls.length >= MAX_URLS) break;
              allUrls.push(u);
            }
          }
        } catch {
          // Skip failed child sitemaps
        }
      }

      return { urls: allUrls.slice(0, MAX_URLS), source: "sitemap_index" };
    }

    const urls = parseSitemapXml(xml).slice(0, MAX_URLS);
    return { urls, source: "sitemap.xml" };
  } catch {
    return { urls: [], source: "none" };
  }
}

async function tryRobotsTxt(baseUrl: string): Promise<SitemapResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const res = await fetch(`${baseUrl}/robots.txt`, {
      signal: controller.signal,
      headers: { "User-Agent": "SchemaGen/1.0 (sitemap crawler)" },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { urls: [], source: "none" };
    }

    const text = await res.text();
    const sitemapLines = text
      .split("\n")
      .filter((line) => line.toLowerCase().startsWith("sitemap:"))
      .map((line) => line.replace(/^sitemap:\s*/i, "").trim())
      .filter(Boolean);

    if (sitemapLines.length === 0) {
      return { urls: [], source: "none" };
    }

    // Fetch the first sitemap URL found in robots.txt
    const result = await tryFetchSitemap(sitemapLines[0]);
    return result;
  } catch {
    return { urls: [], source: "none" };
  }
}
