/**
 * Storefront password bypass for L4 live-verify (the dev-store gotcha).
 *
 * Shopify **development stores** (and any store with "Password protect this store"
 * enabled under Online Store → Preferences) gate the storefront: every
 * unauthenticated request — including `?preview_theme_id=` — 302-redirects to
 * `/password`. The agent's L4 verify fetches the rendered page to confirm the
 * JSON-LD it just wrote actually appears; on a gated store that fetch only ever
 * sees the password wall, so L4 fails and the apply rolls back even though the
 * write succeeded. That's the "fails right after writing" symptom.
 *
 * The fix: submit the storefront password once to obtain the session cookie
 * Shopify sets for an authenticated visitor (`_shopify_essential` on current
 * stores, `storefront_digest` on older ones), then send that cookie jar on the
 * verify fetch. With the cookie present, the storefront renders normally (and
 * honors `preview_theme_id`), so L4 can read the real page.
 *
 * The password is read from `SHOPIFY_STOREFRONT_PASSWORD`. When it's unset, this
 * returns null and the caller surfaces an actionable message rather than a
 * mysterious rollback.
 */
import { normalizeShop } from "./config";
import { assertShopifyUrl } from "./ssrf";
import { shopifyLog } from "./logger";

const TIMEOUT_MS = 15_000;

/** shop -> `storefront_digest=…` cookie. In-process; a run completes well within one TTL. */
const cookieCache = new Map<string, string>();

export function isStorefrontPasswordConfigured(): boolean {
  return !!process.env.SHOPIFY_STOREFRONT_PASSWORD;
}

/** Heuristic: did this fetch land on the storefront password wall? */
export function looksPasswordGated(finalUrl: string, html: string): boolean {
  if (/\/password(\?|$)/i.test(finalUrl)) return true;
  // Fallback for stores that render the wall without changing the path.
  return /name=["']password["'][^>]*>[\s\S]{0,4000}?form_type[\s\S]{0,200}?storefront_password/i.test(
    html
  );
}

/**
 * Obtain (and cache) the `storefront_digest` cookie for a password-protected
 * storefront. Returns null when no password is configured or the submission
 * fails — callers degrade gracefully rather than throwing.
 */
export async function getStorefrontCookie(
  shop: string,
  password = process.env.SHOPIFY_STOREFRONT_PASSWORD
): Promise<string | null> {
  if (!password) return null;
  const host = normalizeShop(shop);

  const cached = cookieCache.get(host);
  if (cached) return cached;

  const url = `https://${host}/password`;
  assertShopifyUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        form_type: "storefront_password",
        utf8: "✓",
        password,
      }).toString(),
      // We want the Set-Cookie off the 302, not to follow it to the homepage.
      redirect: "manual",
      signal: controller.signal,
    });

    // Node/undici exposes multiple Set-Cookie headers via getSetCookie().
    const setCookies: string[] =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);

    // Build a cookie jar from every Set-Cookie's first `name=value` segment (drop the
    // attributes and any deletion cookies with an empty value). Older stores unlocked the
    // storefront via `storefront_digest`; current Shopify authenticates the unlocked
    // session through `_shopify_essential`. We echo the whole jar back (what a browser
    // does) and treat the presence of EITHER auth cookie as success — so the helper keeps
    // working across Shopify's cookie-name change instead of silently returning null.
    const pairs = setCookies
      .map((c) => c.split(";")[0].trim())
      .filter((p) => {
        const eq = p.indexOf("=");
        return eq > 0 && p.slice(eq + 1).length > 0;
      });
    const names = pairs.map((p) => p.slice(0, p.indexOf("=")));
    const authed = names.some(
      (n) => n === "_shopify_essential" || n === "storefront_digest"
    );

    if (!authed) {
      shopifyLog("warn", "Storefront password submitted but no session cookie returned", {
        shop: host,
        status: res.status,
        cookieNames: names,
      });
      return null;
    }

    const jar = pairs.join("; ");
    cookieCache.set(host, jar);
    shopifyLog("info", "Obtained storefront session cookie for live verify", {
      shop: host,
      cookieNames: names,
    });
    return jar;
  } catch (err) {
    shopifyLog("warn", "Failed to obtain storefront cookie", {
      shop: host,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Test/seam hook: clear the in-process cookie cache. */
export function _clearStorefrontCookieCache(): void {
  cookieCache.clear();
}
