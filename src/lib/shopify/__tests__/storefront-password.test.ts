import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getStorefrontCookie,
  looksPasswordGated,
  isStorefrontPasswordConfigured,
  _clearStorefrontCookieCache,
} from "../storefront-password";

describe("looksPasswordGated", () => {
  it("detects the /password redirect by final URL", () => {
    expect(looksPasswordGated("https://shop.myshopify.com/password", "<html></html>")).toBe(true);
    expect(looksPasswordGated("https://shop.myshopify.com/password?foo=1", "")).toBe(true);
  });

  it("detects an inline password form when the path didn't change", () => {
    const html = `<form><input name="password" type="password"><input type="hidden" name="form_type" value="storefront_password"></form>`;
    expect(looksPasswordGated("https://shop.myshopify.com/", html)).toBe(true);
  });

  it("returns false for a normal rendered page", () => {
    expect(
      looksPasswordGated("https://shop.myshopify.com/products/x", '<script type="application/ld+json">{}</script>')
    ).toBe(false);
  });
});

describe("getStorefrontCookie", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    _clearStorefrontCookieCache();
    process.env.SHOPIFY_STOREFRONT_PASSWORD = "letmein";
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.SHOPIFY_STOREFRONT_PASSWORD;
  });

  it("returns null (no network) when no password is configured", async () => {
    delete process.env.SHOPIFY_STOREFRONT_PASSWORD;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    expect(await getStorefrontCookie("shop.myshopify.com")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /** A 302 response carrying real Set-Cookie headers (undici exposes getSetCookie()). */
  function cookieResponse(cookies: string[], status = 302): Response {
    const headers = new Headers();
    for (const c of cookies) headers.append("set-cookie", c);
    return new Response(null, { status, headers });
  }

  it("submits the password and extracts the storefront_digest cookie", async () => {
    global.fetch = vi.fn(async () =>
      cookieResponse(["storefront_digest=abc123; path=/; HttpOnly", "_other=ignore; path=/"])
    ) as unknown as typeof fetch;

    const cookie = await getStorefrontCookie("ethan-dev-store-1.myshopify.com");
    expect(cookie).toBe("storefront_digest=abc123");
  });

  it("caches the cookie so the password is submitted only once per shop", async () => {
    const fetchSpy = vi.fn(async () => cookieResponse(["storefront_digest=zzz; path=/"]));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await getStorefrontCookie("shop.myshopify.com");
    await getStorefrontCookie("shop.myshopify.com");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null when no storefront_digest cookie comes back", async () => {
    global.fetch = vi.fn(async () => cookieResponse(["_only=nope; path=/"], 200)) as unknown as typeof fetch;
    expect(await getStorefrontCookie("shop.myshopify.com")).toBeNull();
  });

  it("isStorefrontPasswordConfigured reflects the env", () => {
    expect(isStorefrontPasswordConfigured()).toBe(true);
    delete process.env.SHOPIFY_STOREFRONT_PASSWORD;
    expect(isStorefrontPasswordConfigured()).toBe(false);
  });
});
