import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_API_VERSION,
  canMintTokens,
  getOfflineToken,
  getShopifyConfig,
  invalidateTokenCache,
  mintToken,
  normalizeShop,
} from "../config";

function oauthResponse(
  body: unknown,
  status = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("normalizeShop", () => {
  it("appends .myshopify.com to a bare handle", () => {
    expect(normalizeShop("my-store")).toBe("my-store.myshopify.com");
  });

  it("leaves a full host unchanged", () => {
    expect(normalizeShop("my-store.myshopify.com")).toBe(
      "my-store.myshopify.com"
    );
  });

  it("strips protocol and path", () => {
    expect(normalizeShop("https://my-store.myshopify.com/admin")).toBe(
      "my-store.myshopify.com"
    );
  });

  it("lowercases and trims", () => {
    expect(normalizeShop("  My-Store.MyShopify.Com  ")).toBe(
      "my-store.myshopify.com"
    );
  });
});

describe("getShopifyConfig", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SHOPIFY_SHOP;
    delete process.env.SHOPIFY_API_VERSION;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("throws when SHOPIFY_SHOP is missing", () => {
    expect(() => getShopifyConfig()).toThrow(/SHOPIFY_SHOP is not set/);
  });

  it("builds a base url and defaults the api version", () => {
    process.env.SHOPIFY_SHOP = "my-store";
    const cfg = getShopifyConfig();
    expect(cfg.shop).toBe("my-store.myshopify.com");
    expect(cfg.apiVersion).toBe(DEFAULT_API_VERSION);
    expect(cfg.baseUrl).toBe(
      `https://my-store.myshopify.com/admin/api/${DEFAULT_API_VERSION}`
    );
  });

  it("honors an explicit api version", () => {
    process.env.SHOPIFY_SHOP = "my-store.myshopify.com";
    process.env.SHOPIFY_API_VERSION = "2026-04";
    expect(getShopifyConfig().apiVersion).toBe("2026-04");
  });

  it("rejects a hostile shop value via the SSRF guard", () => {
    process.env.SHOPIFY_SHOP = "evil.com/";
    expect(() => getShopifyConfig()).toThrow(/Refusing to contact/);
  });
});

describe("getOfflineToken (static fallback, no app creds)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SHOPIFY_APP_KEY;
    delete process.env.SHOPIFY_APP_SECRET;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns the static env token when minting isn't possible", async () => {
    process.env.SHOPIFY_OFFLINE_TOKEN = "shpat_test";
    await expect(getOfflineToken("my-store.myshopify.com")).resolves.toBe(
      "shpat_test"
    );
  });

  it("throws when there are no credentials at all", async () => {
    delete process.env.SHOPIFY_OFFLINE_TOKEN;
    await expect(getOfflineToken("my-store.myshopify.com")).rejects.toThrow(
      /No Shopify credentials/
    );
  });
});

describe("token minting (app creds present)", () => {
  const saved = { ...process.env };
  let mockFetch: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.SHOPIFY_APP_KEY = "client-id-123";
    process.env.SHOPIFY_APP_SECRET = "client-secret-xyz";
    invalidateTokenCache("mint-store.myshopify.com");
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it("canMintTokens reflects app-credential presence", () => {
    expect(canMintTokens()).toBe(true);
    delete process.env.SHOPIFY_APP_KEY;
    expect(canMintTokens()).toBe(false);
  });

  it("mintToken posts the client_credentials grant and parses the token", async () => {
    mockFetch.mockResolvedValue(
      oauthResponse({ access_token: "shpat_minted", expires_in: 86399 })
    );
    const before = Date.now();
    const result = await mintToken("mint-store.myshopify.com");

    expect(result.token).toBe("shpat_minted");
    expect(result.expiresAt).toBeGreaterThan(before);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://mint-store.myshopify.com/admin/oauth/access_token"
    );
    expect(init.method).toBe("POST");
    expect(init.body).toContain("grant_type=client_credentials");
    expect(init.body).toContain("client_id=client-id-123");
    expect(init.redirect).toBe("error");
  });

  it("mintToken throws on a non-ok response", async () => {
    mockFetch.mockResolvedValue(oauthResponse({ error: "invalid_client" }, 401));
    await expect(mintToken("mint-store.myshopify.com")).rejects.toThrow(
      /Token mint failed \(401\)/
    );
  });

  it("mintToken throws when app creds are absent", async () => {
    delete process.env.SHOPIFY_APP_KEY;
    await expect(mintToken("mint-store.myshopify.com")).rejects.toThrow(
      /SHOPIFY_APP_KEY and SHOPIFY_APP_SECRET/
    );
  });

  it("getOfflineToken mints then serves from cache (no re-mint)", async () => {
    mockFetch.mockResolvedValue(
      oauthResponse({ access_token: "shpat_cached", expires_in: 86399 })
    );
    const t1 = await getOfflineToken("mint-store.myshopify.com");
    const t2 = await getOfflineToken("mint-store.myshopify.com");
    expect(t1).toBe("shpat_cached");
    expect(t2).toBe("shpat_cached");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("getOfflineToken re-mints when the cached token is within the expiry buffer", async () => {
    mockFetch
      .mockResolvedValueOnce(
        oauthResponse({ access_token: "shpat_old", expires_in: 60 })
      ) // 60s < 5min buffer => already stale
      .mockResolvedValueOnce(
        oauthResponse({ access_token: "shpat_new", expires_in: 86399 })
      );
    expect(await getOfflineToken("mint-store.myshopify.com")).toBe("shpat_old");
    expect(await getOfflineToken("mint-store.myshopify.com")).toBe("shpat_new");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("invalidateTokenCache forces a re-mint", async () => {
    mockFetch
      .mockResolvedValueOnce(
        oauthResponse({ access_token: "shpat_a", expires_in: 86399 })
      )
      .mockResolvedValueOnce(
        oauthResponse({ access_token: "shpat_b", expires_in: 86399 })
      );
    expect(await getOfflineToken("mint-store.myshopify.com")).toBe("shpat_a");
    invalidateTokenCache("mint-store.myshopify.com");
    expect(await getOfflineToken("mint-store.myshopify.com")).toBe("shpat_b");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("never logs the client secret when minting", async () => {
    mockFetch.mockResolvedValue(
      oauthResponse({ access_token: "shpat_x", expires_in: 86399 })
    );
    await mintToken("mint-store.myshopify.com");
    const logged = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    expect(logged).not.toContain("client-secret-xyz");
  });

  it("treats expires_in: 0 as already-expired and re-mints next call", async () => {
    mockFetch
      .mockResolvedValueOnce(
        oauthResponse({ access_token: "shpat_zero", expires_in: 0 })
      )
      .mockResolvedValueOnce(
        oauthResponse({ access_token: "shpat_fresh", expires_in: 86399 })
      );
    expect(await getOfflineToken("mint-store.myshopify.com")).toBe("shpat_zero");
    expect(await getOfflineToken("mint-store.myshopify.com")).toBe("shpat_fresh");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent cold-cache mints into one OAuth call", async () => {
    mockFetch.mockResolvedValue(
      oauthResponse({ access_token: "shpat_sf", expires_in: 86399 })
    );
    const [a, b] = await Promise.all([
      getOfflineToken("mint-store.myshopify.com"),
      getOfflineToken("mint-store.myshopify.com"),
    ]);
    expect(a).toBe("shpat_sf");
    expect(b).toBe("shpat_sf");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
