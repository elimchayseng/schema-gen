import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_API_VERSION,
  getOfflineToken,
  getShopifyConfig,
  normalizeShop,
} from "../config";

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

describe("getOfflineToken", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns the env token", async () => {
    process.env.SHOPIFY_OFFLINE_TOKEN = "shpat_test";
    await expect(getOfflineToken("my-store.myshopify.com")).resolves.toBe(
      "shpat_test"
    );
  });

  it("throws when the token is missing", async () => {
    delete process.env.SHOPIFY_OFFLINE_TOKEN;
    await expect(getOfflineToken("my-store.myshopify.com")).rejects.toThrow(
      /SHOPIFY_OFFLINE_TOKEN is not set/
    );
  });
});
