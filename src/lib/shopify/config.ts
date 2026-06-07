/**
 * Shopify config + credential access (agent Phase 0).
 *
 * Phase 0 reads a single dev store's offline token from the environment.
 * `getOfflineToken` is the seam: when multi-store support lands (OAuth install
 * + encrypted per-shop tokens in Supabase, Phase 4), only this function changes
 * — callers already await it.
 */
import type { ShopifyConfig } from "./types";
import { assertShopifyHost } from "./ssrf";

/** Used when SHOPIFY_API_VERSION is unset. Override via env per store/quarter. */
export const DEFAULT_API_VERSION = "2025-01";

/**
 * Normalize a raw shop value into a bare host.
 * Accepts "my-store", "my-store.myshopify.com", or "https://my-store.myshopify.com/admin".
 */
export function normalizeShop(raw: string): string {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return host.endsWith(".myshopify.com") ? host : `${host}.myshopify.com`;
}

export function getShopifyConfig(): ShopifyConfig {
  const rawShop = process.env.SHOPIFY_SHOP;
  if (!rawShop) {
    throw new Error("SHOPIFY_SHOP is not set");
  }
  const shop = normalizeShop(rawShop);
  assertShopifyHost(shop); // fail fast on a bad/hostile shop value
  const apiVersion = process.env.SHOPIFY_API_VERSION?.trim() || DEFAULT_API_VERSION;
  const baseUrl = `https://${shop}/admin/api/${apiVersion}`;
  return { shop, apiVersion, baseUrl };
}

/**
 * Resolve the offline access token for a shop.
 *
 * Phase 0: env-only (single dev store). The `shop` argument is accepted now so
 * the call sites are already shaped for the future per-shop encrypted lookup;
 * it is validated but not yet used for routing.
 *
 * Async by design: the eventual Supabase-backed lookup is async, so making the
 * seam async now means swapping the body later is not a call-site change.
 */
export async function getOfflineToken(shop: string): Promise<string> {
  // Reserved for the future per-shop lookup; keep the signature honest.
  void shop;
  const token = process.env.SHOPIFY_OFFLINE_TOKEN;
  if (!token) {
    throw new Error("SHOPIFY_OFFLINE_TOKEN is not set");
  }
  return token;
}
