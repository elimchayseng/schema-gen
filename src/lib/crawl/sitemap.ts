import * as cheerio from "cheerio";
import type { SitemapResult, SitemapUrl } from "./types";

const MAX_URLS = 100;
const FETCH_TIMEOUT = 10_000;

// ─── Quality filtering (Phase 5, TODOS "Sitemap quality filtering") ──────────

/** Path prefixes that are never content pages on a Shopify storefront. */
const JUNK_PATH_PREFIXES = [
  "/cart",
  "/account",
  "/checkout",
  "/admin",
  "/policies/",
  "/search",
  "/password",
  "/challenge",
  "/72", // Shopify cart-token style noise occasionally seen in feeds
];

/** Extensions for feeds/assets that aren't HTML pages. */
const JUNK_EXTENSIONS = [
  ".atom",
  ".json",
  ".xml",
  ".rss",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".pdf",
  ".css",
  ".js",
];

/** Query params that signal a paginated/variant/tracking duplicate, not a new page. */
const JUNK_QUERY_KEYS = ["page", "variant"];

function isJunkUrl(u: URL): boolean {
  const path = u.pathname.toLowerCase();

  if (JUNK_PATH_PREFIXES.some((p) => path === p || path.startsWith(p))) {
    return true;
  }
  if (JUNK_EXTENSIONS.some((ext) => path.endsWith(ext))) {
    return true;
  }
  // Shopify emits a collection-scoped duplicate of every product
  // (/collections/<x>/products/<y>); the canonical is /products/<y>.
  if (/^\/collections\/[^/]+\/products\//.test(path)) {
    return true;
  }
  for (const key of u.searchParams.keys()) {
    const k = key.toLowerCase();
    if (JUNK_QUERY_KEYS.includes(k) || k.startsWith("utm_")) return true;
  }
  return false;
}

/** Dedup key: lowercased host + path with a single trailing slash stripped, query dropped. */
function normalizedKey(u: URL): string {
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.host.toLowerCase()}${path}`;
}

/**
 * Drop admin/duplicate/feed/pagination URLs and de-duplicate. Pure and exported for
 * direct unit testing; applied inside `fetchSitemap` so both the site-wide crawl and
 * the agent ingest clean URL lists. Unparseable locs are dropped.
 */
export function filterSitemapUrls(urls: SitemapUrl[]): SitemapUrl[] {
  const seen = new Set<string>();
  const out: SitemapUrl[] = [];
  for (const entry of urls) {
    let parsed: URL;
    try {
      parsed = new URL(entry.loc);
    } catch {
      continue; // not an absolute URL → drop
    }
    if (isJunkUrl(parsed)) continue;
    const key = normalizedKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

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
    return {
      ...directResult,
      urls: filterSitemapUrls(directResult.urls),
      source: directResult.source === "sitemap_index" ? "sitemap_index" : "sitemap.xml",
    };
  }

  // Try 2: robots.txt
  const robotsResult = await tryRobotsTxt(baseUrl);
  if (robotsResult.urls.length > 0) {
    return { ...robotsResult, urls: filterSitemapUrls(robotsResult.urls), source: "robots.txt" };
  }

  // Try 3: /sitemap_index.xml
  const indexResult = await tryFetchSitemap(`${baseUrl}/sitemap_index.xml`);
  if (indexResult.urls.length > 0) {
    return { ...indexResult, urls: filterSitemapUrls(indexResult.urls), source: "sitemap_index" };
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
