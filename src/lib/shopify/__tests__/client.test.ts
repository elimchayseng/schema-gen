import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ShopifyError,
  retryDelayMs,
  shopifyFetch,
  type RetryConfig,
} from "../client";
import { invalidateTokenCache } from "../config";

// Fast, deterministic retry config for tests: no real waiting.
const fastRetry: Partial<RetryConfig> = {
  baseDelayMs: 0,
  maxDelayMs: 0,
  sleep: async () => {},
};

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("retryDelayMs", () => {
  const cfg = { baseDelayMs: 500, maxDelayMs: 30_000 };

  it("honors a numeric Retry-After (seconds → ms)", () => {
    expect(retryDelayMs("2", 0, cfg)).toBe(2000);
  });

  it("caps Retry-After at maxDelayMs", () => {
    expect(retryDelayMs("9999", 0, cfg)).toBe(30_000);
  });

  it("falls back to exponential backoff for a missing header", () => {
    expect(retryDelayMs(null, 0, cfg)).toBe(500);
    expect(retryDelayMs(null, 1, cfg)).toBe(1000);
    expect(retryDelayMs(null, 3, cfg)).toBe(4000);
  });

  it("falls back to exponential for a non-numeric header", () => {
    expect(retryDelayMs("soon", 1, cfg)).toBe(1000);
  });

  it("caps exponential growth at maxDelayMs", () => {
    expect(retryDelayMs(null, 20, cfg)).toBe(30_000);
  });
});

describe("shopifyFetch", () => {
  const saved = { ...process.env };
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.SHOPIFY_SHOP = "my-store.myshopify.com";
    process.env.SHOPIFY_API_VERSION = "2025-01";
    process.env.SHOPIFY_OFFLINE_TOKEN = "shpat_secret_token";
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it("injects the access token header and returns parsed JSON", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ theme: { id: 1 } }));

    const result = await shopifyFetch<{ theme: { id: number } }>(
      "/themes/1.json"
    );

    expect(result.theme.id).toBe(1);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://my-store.myshopify.com/admin/api/2025-01/themes/1.json"
    );
    expect(init.method).toBe("GET");
    expect(init.headers["X-Shopify-Access-Token"]).toBe("shpat_secret_token");
    expect(init.redirect).toBe("error");
  });

  it("serializes a body and sets the method for writes", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ asset: { key: "k" } }));

    await shopifyFetch("/themes/1/assets.json", {
      method: "PUT",
      body: { asset: { key: "k", value: "v" } },
      retry: fastRetry,
    });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ asset: { key: "k", value: "v" } });
  });

  it("appends query params", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ asset: {} }));

    await shopifyFetch("/themes/1/assets.json", {
      query: { "asset[key]": "layout/theme.liquid" },
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("asset%5Bkey%5D=layout%2Ftheme.liquid");
  });

  it("backs off on 429 then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ errors: "throttled" }, { status: 429 })
      )
      .mockResolvedValueOnce(jsonResponse({ theme: { id: 7 } }));

    const result = await shopifyFetch<{ theme: { id: number } }>(
      "/themes/7.json",
      { retry: { ...fastRetry, sleep } }
    );

    expect(result.theme.id).toBe(7);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("honors Retry-After on a 429", async () => {
    const sleep = vi.fn(async () => {});
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({}, { status: 429, headers: { "Retry-After": "3" } })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await shopifyFetch("/themes.json", {
      retry: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 30_000, sleep },
    });

    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("throws ShopifyError after exhausting retries on 429", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ errors: "throttled" }, { status: 429 })
    );

    await expect(
      shopifyFetch("/themes.json", { retry: { ...fastRetry, maxRetries: 2 } })
    ).rejects.toMatchObject({ name: "ShopifyError", status: 429 });

    // initial attempt + 2 retries
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries transient 5xx then succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(
      shopifyFetch("/themes.json", { retry: fastRetry })
    ).resolves.toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws ShopifyError on a non-retryable error status without retrying", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ errors: "not found" }, { status: 404 })
    );

    await expect(shopifyFetch("/themes/9.json")).rejects.toMatchObject({
      name: "ShopifyError",
      status: 404,
    });
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("surfaces a timeout as a ShopifyError without retrying", async () => {
    const abortErr = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    mockFetch.mockRejectedValue(abortErr);

    await expect(
      shopifyFetch("/themes.json", { retry: fastRetry })
    ).rejects.toMatchObject({ name: "ShopifyError", status: 0 });
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("normalizes a 200 with non-JSON body into a ShopifyError", async () => {
    // e.g. a proxy/WAF returns an HTML interstitial with status 200
    mockFetch.mockResolvedValue(
      new Response("<!DOCTYPE html><html>nope</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    );

    await expect(shopifyFetch("/themes.json")).rejects.toMatchObject({
      name: "ShopifyError",
      status: 200,
    });
  });

  it("returns an empty object for a 200 with an empty body", async () => {
    mockFetch.mockResolvedValue(new Response("", { status: 200 }));
    await expect(shopifyFetch("/themes/1/assets.json")).resolves.toEqual({});
  });

  it("bubbles a non-abort network error unmodified", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNRESET"));

    await expect(shopifyFetch("/themes.json")).rejects.toThrow("ECONNRESET");
  });

  it("blocks an SSRF attempt before fetching", async () => {
    process.env.SHOPIFY_SHOP = "evil.com";
    await expect(shopifyFetch("/themes.json")).rejects.toThrow(
      /Refusing to contact/
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("exports ShopifyError carrying the status", () => {
    const err = new ShopifyError("boom", 500);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(500);
  });
});

describe("shopifyFetch — 401 re-auth (mintable creds)", () => {
  const saved = { ...process.env };
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.SHOPIFY_SHOP = "reauth-store.myshopify.com";
    process.env.SHOPIFY_API_VERSION = "2025-01";
    process.env.SHOPIFY_APP_KEY = "cid";
    process.env.SHOPIFY_APP_SECRET = "csecret";
    delete process.env.SHOPIFY_OFFLINE_TOKEN; // force the mint path
    invalidateTokenCache("reauth-store.myshopify.com");
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  const isMint = (url: string) => url.includes("/admin/oauth/access_token");

  it("re-mints once on a 401 then succeeds", async () => {
    let mints = 0;
    let apiCalls = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (isMint(url)) {
        mints += 1;
        return jsonResponse({ access_token: `shpat_${mints}`, expires_in: 86399 });
      }
      apiCalls += 1;
      return apiCalls === 1
        ? jsonResponse({ errors: "unauthorized" }, { status: 401 })
        : jsonResponse({ theme: { id: 1 } });
    });

    const result = await shopifyFetch<{ theme: { id: number } }>(
      "/themes/1.json",
      { retry: fastRetry }
    );
    expect(result.theme.id).toBe(1);
    expect(mints).toBe(2); // initial mint + one re-mint after the 401
    expect(apiCalls).toBe(2); // 401, then 200 on retry
  });

  it("retries the 401 with the freshly minted token (not the stale one)", async () => {
    let mints = 0;
    const apiTokens: string[] = [];
    mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (isMint(url)) {
        mints += 1;
        return jsonResponse({ access_token: `shpat_${mints}`, expires_in: 86399 });
      }
      const headers = init.headers as Record<string, string>;
      apiTokens.push(headers["X-Shopify-Access-Token"]);
      return apiTokens.length === 1
        ? jsonResponse({}, { status: 401 })
        : jsonResponse({ ok: true });
    });

    await shopifyFetch("/themes/1.json", { retry: fastRetry });
    expect(apiTokens).toEqual(["shpat_1", "shpat_2"]); // stale, then re-minted
  });

  it("surfaces a failed re-mint as a ShopifyError (contract preserved)", async () => {
    let mints = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (isMint(url)) {
        mints += 1;
        // initial mint ok; the re-mint after the 401 fails
        return mints === 1
          ? jsonResponse({ access_token: "shpat_1", expires_in: 86399 })
          : jsonResponse({ error: "invalid_client" }, { status: 401 });
      }
      return jsonResponse({}, { status: 401 }); // API keeps 401-ing
    });

    await expect(
      shopifyFetch("/themes/1.json", { retry: fastRetry })
    ).rejects.toMatchObject({ name: "ShopifyError", status: 401 });
  });

  it("does not loop: a persistent 401 throws after a single re-auth", async () => {
    let mints = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (isMint(url)) {
        mints += 1;
        return jsonResponse({ access_token: "shpat_x", expires_in: 86399 });
      }
      return jsonResponse({ errors: "unauthorized" }, { status: 401 });
    });

    await expect(
      shopifyFetch("/themes/1.json", { retry: fastRetry })
    ).rejects.toMatchObject({ name: "ShopifyError", status: 401 });
    expect(mints).toBe(2); // initial + exactly one re-mint, then give up
  });
});
