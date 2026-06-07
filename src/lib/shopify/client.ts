/**
 * Low-level Shopify Admin API fetch wrapper (agent Phase 0).
 *
 *   shopifyFetch(path)
 *     ├── build URL from config + query
 *     ├── assertShopifyUrl() ........... SSRF guard on the FINAL url
 *     ├── inject X-Shopify-Access-Token  (never logged)
 *     ├── fetch with AbortController timeout, redirect: "error"
 *     └── on 429 / 5xx ──▶ backoff (Retry-After or exponential) ──▶ retry
 *                          └── retries exhausted ──▶ throw ShopifyError
 *
 * Asset writes (PUT) and publish are idempotent, so retrying transient 5xx is
 * safe. Timeouts are NOT retried here — they bubble so the caller decides.
 */
import {
  canMintTokens,
  getOfflineToken,
  getShopifyConfig,
  invalidateTokenCache,
} from "./config";
import { assertShopifyUrl } from "./ssrf";
import { shopifyLog } from "./logger";

const TIMEOUT_MS = 15_000;

export interface RetryConfig {
  maxRetries: number;
  /** Base for exponential backoff (ms). delay = baseDelayMs * 2^attempt. */
  baseDelayMs: number;
  /** Max single backoff (ms), also caps a Retry-After we'll honor. */
  maxDelayMs: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ShopifyFetchOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  retry?: Partial<RetryConfig>;
}

/** Error carrying the HTTP status (0 for non-HTTP failures like timeouts). */
export class ShopifyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ShopifyError";
    this.status = status;
  }
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string>
): string {
  const url = new URL(baseUrl + (path.startsWith("/") ? path : `/${path}`));
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

/**
 * Compute the backoff delay before the next retry. Honors a `Retry-After`
 * header (Shopify sends seconds, possibly fractional) when present and valid,
 * otherwise falls back to exponential backoff. Always capped at maxDelayMs.
 * Pure function — unit-tested directly.
 */
export function retryDelayMs(
  retryAfterHeader: string | null,
  attempt: number,
  cfg: Pick<RetryConfig, "baseDelayMs" | "maxDelayMs">
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, cfg.maxDelayMs);
    }
  }
  return Math.min(cfg.baseDelayMs * 2 ** attempt, cfg.maxDelayMs);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export async function shopifyFetch<T>(
  path: string,
  opts: ShopifyFetchOptions = {}
): Promise<T> {
  const cfg: RetryConfig = { ...DEFAULT_RETRY, ...opts.retry };
  const config = getShopifyConfig();
  let token = await getOfflineToken(config.shop);
  const url = buildUrl(config.baseUrl, path, opts.query);
  assertShopifyUrl(url); // SSRF guard on the exact URL we are about to hit
  const method = opts.method ?? "GET";

  let attempt = 0;
  let reauthed = false;
  // Loop: returns on success, throws on hard failure or exhausted retries.
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          // Token is in the header only; it is never passed to shopifyLog.
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
        // Admin API never legitimately redirects; following one could leak the
        // token to another host, so treat a redirect as an error.
        redirect: "error",
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new ShopifyError(
          `Shopify request timed out after ${TIMEOUT_MS}ms: ${method} ${path}`,
          0
        );
      }
      throw err; // network/other errors bubble unmodified
    }
    clearTimeout(timer);

    // Token expired/invalid: re-mint once and retry. Only when we can actually
    // mint (a static token can't be refreshed) and only once (no auth loop).
    if (res.status === 401 && canMintTokens() && !reauthed) {
      shopifyLog("warn", "Shopify 401, re-minting token and retrying once", {
        path,
      });
      invalidateTokenCache(config.shop);
      try {
        token = await getOfflineToken(config.shop);
      } catch (err) {
        // Keep the ShopifyError contract: a failed re-mint surfaces as a 401
        // ShopifyError, not a bare Error callers can't catch via instanceof.
        const msg = err instanceof Error ? err.message : String(err);
        throw new ShopifyError(
          `Re-auth failed after 401: ${method} ${path}: ${msg}`,
          401
        );
      }
      reauthed = true;
      continue;
    }

    if (isRetryableStatus(res.status)) {
      if (attempt >= cfg.maxRetries) {
        throw new ShopifyError(
          `Shopify API ${res.status} after ${cfg.maxRetries} retries: ${method} ${path}`,
          res.status
        );
      }
      const delay = retryDelayMs(res.headers.get("Retry-After"), attempt, cfg);
      shopifyLog("warn", "Shopify rate/limit response, backing off", {
        status: res.status,
        attempt,
        delayMs: delay,
        path,
      });
      attempt += 1;
      await cfg.sleep(delay);
      continue;
    }

    if (!res.ok) {
      // Cap upstream body so a large/HTML error page can't bloat logs.
      const detail = (await safeText(res)).slice(0, 500);
      throw new ShopifyError(
        `Shopify API ${res.status}: ${method} ${path} ${detail}`.trim(),
        res.status
      );
    }

    const text = await res.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A 200 with non-JSON (proxy/WAF interstitial, truncated body) would
      // otherwise throw a context-free SyntaxError that callers can't catch
      // via `instanceof ShopifyError`. Normalize it.
      throw new ShopifyError(
        `Invalid JSON from Shopify (${res.status}): ${method} ${path}`,
        res.status
      );
    }
  }
}
