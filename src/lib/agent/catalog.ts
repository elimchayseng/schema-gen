/**
 * Admin-API catalog enumeration (issue #27). A password-gated dev store serves
 * no public sitemap (every request 302s to /password), so a "whole site" run
 * would resolve zero targets. When the sitemap comes back empty AND Shopify
 * credentials resolve for the site, enumerate the catalog through the Admin
 * REST API instead:
 *
 *   products.json            -> https://<public domain>/products/<handle>
 *   custom_collections.json  ┐
 *   smart_collections.json   ┴> https://<public domain>/collections/<handle>
 *
 * Pagination is since_id-based (deterministic, no Link-header parsing needed —
 * shopifyFetch only returns parsed bodies). Strictly best-effort: any failure
 * (no credentials, 401 from a foreign store, network) degrades to [] and the
 * run proceeds with whatever the sitemap gave. No LLM, no theme writes.
 */
import { shopifyFetch } from "@/lib/shopify/client";
import { resolveShopContext } from "@/lib/shopify/credentials";
import type { ShopContext } from "@/lib/shopify/types";

const PAGE_LIMIT = 250;
/** Hard stop on pagination loops — 20 pages × 250 = 5000 resources, plenty. */
const MAX_PAGES = 20;

interface HandleRow {
  id: number;
  handle: string;
}

/** Page through one Admin REST listing endpoint, collecting handles in id order. */
async function listHandles(
  path: string,
  responseKey: string,
  ctx: ShopContext
): Promise<string[]> {
  const handles: string[] = [];
  let sinceId = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await shopifyFetch<Record<string, HandleRow[]>>(path, {
      shopContext: ctx,
      query: {
        limit: String(PAGE_LIMIT),
        fields: "id,handle",
        since_id: String(sinceId),
      },
    });
    const rows = res[responseKey] ?? [];
    for (const row of rows) {
      if (row.handle) handles.push(row.handle);
      if (row.id > sinceId) sinceId = row.id;
    }
    if (rows.length < PAGE_LIMIT) break;
  }
  return handles;
}

/**
 * Enumerate the store's catalog URLs via the Admin API: home, then products,
 * then collections (the same priority order resolveTargetUrls applies). URLs
 * are built on the site's PUBLIC domain — the agent perceives/verifies the
 * storefront, not the myshopify admin host. Returns [] when credentials don't
 * resolve for the shop or any Admin call fails (best-effort by contract).
 */
export async function enumerateCatalogUrls(
  publicDomain: string,
  shopDomain: string | null
): Promise<string[]> {
  let ctx: ShopContext;
  try {
    // Gate: only stores whose credentials actually resolve get enumerated.
    ctx = await resolveShopContext(shopDomain ?? publicDomain);
  } catch {
    return [];
  }

  const base = `https://${publicDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  try {
    const products = await listHandles("/products.json", "products", ctx);
    const custom = await listHandles(
      "/custom_collections.json",
      "custom_collections",
      ctx
    );
    const smart = await listHandles(
      "/smart_collections.json",
      "smart_collections",
      ctx
    );
    return [
      `${base}/`,
      ...products.map((h) => `${base}/products/${h}`),
      ...[...custom, ...smart].map((h) => `${base}/collections/${h}`),
    ];
  } catch {
    return [];
  }
}
