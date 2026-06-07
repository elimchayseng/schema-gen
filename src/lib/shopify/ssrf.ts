/**
 * SSRF guard for outbound Shopify Admin API requests.
 *
 * Extends the posture in src/lib/url-validator/fetcher.ts (isPrivateHostname).
 * The crawler's job is to fetch arbitrary public URLs while blocking private
 * ranges. The Shopify client is the opposite: it must ONLY ever talk to the
 * configured shop's `*.myshopify.com` admin host over HTTPS. So here we use a
 * strict allowlist, with the private-range block kept as defense in depth.
 *
 *   request URL ──▶ assertShopifyUrl()
 *                     ├── protocol must be https:
 *                     └── host ──▶ assertShopifyHost()
 *                                    ├── matches ^<store>.myshopify.com$
 *                                    └── not a private/reserved host
 */
import { isPrivateHostname } from "@/lib/url-validator/fetcher";

/**
 * A Shopify shop host is a single store label followed by ".myshopify.com".
 * Store handles are lowercase alphanumeric, may contain interior hyphens, and
 * contain no dots — they neither start nor end with a hyphen. This rejects
 * look-alikes such as "evil.com", "shop.myshopify.com.evil.com",
 * "a.b.myshopify.com", and malformed handles like "store-.myshopify.com".
 */
const SHOPIFY_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.myshopify\.com$/;

export function isValidShopifyHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (!SHOPIFY_HOST_RE.test(lower)) return false;
  // Belt and suspenders: a valid *.myshopify.com host is never private, but
  // keep the check so any future allowlist change can't reopen SSRF.
  if (isPrivateHostname(lower)) return false;
  return true;
}

export function assertShopifyHost(host: string): void {
  if (!isValidShopifyHost(host)) {
    throw new Error(
      `Refusing to contact non-Shopify or private host: ${host}`
    );
  }
}

/**
 * Validate that a fully-built request URL is safe to send: HTTPS only, and the
 * host passes the Shopify allowlist. Call this on the final URL right before
 * fetch() so query strings / path joins can't smuggle in a different host.
 */
export function assertShopifyUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid Shopify URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Shopify API must use https, got: ${url}`);
  }
  assertShopifyHost(parsed.hostname);
}
