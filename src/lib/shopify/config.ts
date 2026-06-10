/**
 * Shopify config + credential access (agent Phase 0, token lifecycle Phase 6).
 *
 * The `dev.shopify.com` app issues Admin API tokens via the OAuth
 * `client_credentials` grant, and those tokens expire in ~24h. So token access
 * is mint-on-demand: getOfflineToken exchanges client_id/client_secret -> token,
 * caches it with its expiry, and re-mints proactively (near expiry) or
 * reactively (client.ts retries once on a 401). A static SHOPIFY_OFFLINE_TOKEN
 * is still honored when no app credentials are available.
 *
 * Credential precedence:
 *   SHOPIFY_APP_KEY + SHOPIFY_APP_SECRET present -> mint-on-demand (durable)
 *   else SHOPIFY_OFFLINE_TOKEN present           -> static token (no refresh)
 *   else                                          -> throw
 */
import type { ShopAppCredentials, ShopifyConfig } from "./types";
import { assertShopifyHost, assertShopifyUrl } from "./ssrf";
import { shopifyLog } from "./logger";

/** Used when SHOPIFY_API_VERSION is unset. Override via env per store/quarter. */
export const DEFAULT_API_VERSION = "2025-01";

/** Re-mint this long before the reported expiry to avoid racing the clock. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const OAUTH_TIMEOUT_MS = 15_000;
/** Fallback lifetime if the token endpoint omits expires_in (it reports ~86399). */
const DEFAULT_TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

interface CachedToken {
  token: string;
  /** Epoch ms when the token expires. */
  expiresAt: number;
}

/** Per-shop in-process token cache. Sufficient for a long-running agent run; a
 * Supabase-backed tier is the serverless follow-up noted in phase-6 docs. */
const tokenCache = new Map<string, CachedToken>();

/** In-flight mints, so concurrent cold-cache callers for one shop share a single
 * OAuth round-trip instead of stampeding the endpoint (single-flight). */
const pendingMints = new Map<string, Promise<CachedToken>>();

/** One-time guard for the "static token shadowed by app creds" debug note. */
let warnedStaticShadow = false;

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
  return getShopifyConfigForShop(rawShop);
}

/**
 * Per-shop variant of getShopifyConfig (issue #25): build the Admin API config
 * for an explicit shop instead of env SHOPIFY_SHOP. API version still comes
 * from env (it is a SchemaGen-wide choice, not a per-store one).
 */
export function getShopifyConfigForShop(shop: string): ShopifyConfig {
  const host = normalizeShop(shop);
  assertShopifyHost(host); // fail fast on a bad/hostile shop value
  const apiVersion = process.env.SHOPIFY_API_VERSION?.trim() || DEFAULT_API_VERSION;
  const baseUrl = `https://${host}/admin/api/${apiVersion}`;
  return { shop: host, apiVersion, baseUrl };
}

/**
 * True when app credentials are present, i.e. tokens can be minted/refreshed.
 * Pass per-shop credentials (issue #25) to ask about a specific shop; with no
 * argument this reflects the env pair, as before.
 */
export function canMintTokens(creds?: ShopAppCredentials): boolean {
  if (creds) return !!(creds.appKey && creds.appSecret);
  return !!(process.env.SHOPIFY_APP_KEY && process.env.SHOPIFY_APP_SECRET);
}

/**
 * Mint a fresh Admin API token via the OAuth client_credentials grant. The app
 * must already be installed on the shop (an un-installed app returns
 * 400 app_not_installed). Secrets are sent in the body and never logged.
 * Per-shop credentials (issue #25) take precedence over the env pair.
 */
export async function mintToken(
  shop: string,
  creds?: ShopAppCredentials
): Promise<CachedToken> {
  const host = normalizeShop(shop);
  const clientId = creds?.appKey ?? process.env.SHOPIFY_APP_KEY;
  const clientSecret = creds?.appSecret ?? process.env.SHOPIFY_APP_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SHOPIFY_APP_KEY and SHOPIFY_APP_SECRET are required to mint a token");
  }
  const url = `https://${host}/admin/oauth/access_token`;
  assertShopifyUrl(url); // SSRF guard on the exact mint URL

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: controller.signal,
      redirect: "error",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // Shopify's oauth error body is e.g. {"error":"invalid_client"} — no secret.
      throw new Error(`Token mint failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      throw new Error("Token mint response missing access_token");
    }
    // `!= null` not truthiness: expires_in of 0 means "already expired", which
    // must NOT be widened to the 23h default.
    const ttlMs =
      json.expires_in != null ? json.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS;
    shopifyLog("info", "Minted Shopify token", { shop: host, ttlSeconds: json.expires_in });
    return { token: json.access_token, expiresAt: Date.now() + ttlMs };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Token mint timed out after ${OAUTH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Drop any cached token for a shop, forcing a re-mint on the next call. */
export function invalidateTokenCache(shop: string): void {
  tokenCache.delete(normalizeShop(shop));
}

/**
 * Resolve a valid Admin API token for a shop. Mints + caches when app
 * credentials are present (refreshing near expiry); otherwise falls back to a
 * static SHOPIFY_OFFLINE_TOKEN.
 *
 * Pass per-shop `creds` (issue #25, from resolveShopCredentials) to mint with
 * that shop's app key pair; the cache and single-flight maps are already keyed
 * per shop, so tokens for different stores never collide. Without `creds`,
 * behavior is exactly the pre-#25 env path.
 */
export async function getOfflineToken(
  shop: string,
  creds?: ShopAppCredentials
): Promise<string> {
  const host = normalizeShop(shop);

  if (!canMintTokens(creds)) {
    const token = process.env.SHOPIFY_OFFLINE_TOKEN;
    if (!token) {
      throw new Error(
        "No Shopify credentials: set SHOPIFY_APP_KEY + SHOPIFY_APP_SECRET (to mint) or SHOPIFY_OFFLINE_TOKEN (static)"
      );
    }
    return token;
  }

  if (process.env.SHOPIFY_OFFLINE_TOKEN && !warnedStaticShadow) {
    warnedStaticShadow = true;
    shopifyLog(
      "debug",
      "App credentials present; SHOPIFY_OFFLINE_TOKEN is ignored (minting instead)"
    );
  }

  const cached = tokenCache.get(host);
  if (cached && Date.now() < cached.expiresAt - EXPIRY_BUFFER_MS) {
    return cached.token;
  }

  // Single-flight: dedupe concurrent mints for the same shop.
  let pending = pendingMints.get(host);
  if (!pending) {
    pending = mintToken(host, creds)
      .then((minted) => {
        tokenCache.set(host, minted);
        return minted;
      })
      .finally(() => {
        pendingMints.delete(host);
      });
    pendingMints.set(host, pending);
  }
  return (await pending).token;
}
