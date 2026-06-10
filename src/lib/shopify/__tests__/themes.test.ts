/**
 * Unit tests for the live-theme safety plumbing (issue #26).
 * shopifyFetch is mocked, so the real assets.ts wrappers run — this verifies
 * both the staging logic AND that the ShopContext is threaded to every call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../client", () => ({
  shopifyFetch: vi.fn(),
}));

import { shopifyFetch, type ShopifyFetchOptions } from "../client";
import {
  assertSafeWriteTheme,
  prepareStagingTheme,
  resolveWriteThemeId,
  themeDuplicate,
  themesList,
} from "../themes";
import type { ShopContext, ShopifyTheme } from "../types";

const mockFetch = vi.mocked(shopifyFetch);

const ctx: ShopContext = {
  shop: "garnerandtow.myshopify.com",
  credentials: { appKey: "key", appSecret: "secret" },
};

const themes: ShopifyTheme[] = [
  { id: 100, name: "Live Horizon", role: "main" },
  { id: 200, name: "Old Dawn", role: "unpublished" },
];

/** Route mocked shopifyFetch calls by path+method, like the real API. */
function routeFetch(
  routes: Record<string, (opts?: ShopifyFetchOptions) => unknown>
) {
  mockFetch.mockImplementation(async (path: string, opts?: ShopifyFetchOptions) => {
    const key = `${opts?.method ?? "GET"} ${path}${
      opts?.query?.["asset[key]"] ? `?${opts.query["asset[key]"]}` : ""
    }`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unmocked route: ${key}`);
    return handler(opts);
  });
}

describe("assertSafeWriteTheme", () => {
  it("returns the theme for a known unpublished target", () => {
    expect(assertSafeWriteTheme(200, themes).name).toBe("Old Dawn");
  });

  it("refuses a published (role main) theme by default", () => {
    expect(() => assertSafeWriteTheme(100, themes)).toThrow(
      /Refusing to write to published theme 100/
    );
  });

  it("allows a published theme only with the explicit override", () => {
    expect(
      assertSafeWriteTheme(100, themes, { allowPublishedWrite: true }).id
    ).toBe(100);
  });

  it("refuses a theme id that does not exist on the shop", () => {
    expect(() => assertSafeWriteTheme(999, themes)).toThrow(
      /theme 999 not found on this shop/
    );
  });
});

describe("resolveWriteThemeId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches themes and applies the guard", async () => {
    mockFetch.mockResolvedValue({ themes });
    await expect(resolveWriteThemeId(100, {}, ctx)).rejects.toThrow(
      /Refusing to write to published theme/
    );
    expect(mockFetch).toHaveBeenCalledWith("/themes.json", {
      shopContext: ctx,
    });
  });

  it("returns the theme when the target is safe", async () => {
    mockFetch.mockResolvedValue({ themes });
    const theme = await resolveWriteThemeId(200);
    expect(theme.id).toBe(200);
  });
});

describe("themesList", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists themes per-shop", async () => {
    mockFetch.mockResolvedValue({ themes });
    const result = await themesList(ctx);
    expect(result).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledWith("/themes.json", {
      shopContext: ctx,
    });
  });
});

describe("themeDuplicate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an unpublished copy and copies text + binary assets", async () => {
    const puts: unknown[] = [];
    routeFetch({
      "GET /themes/100/assets.json": () => ({
        assets: [{ key: "layout/theme.liquid" }, { key: "assets/logo.png" }],
      }),
      "POST /themes.json": () => ({
        theme: { id: 300, name: "staging", role: "unpublished" },
      }),
      "GET /themes/100/assets.json?layout/theme.liquid": () => ({
        asset: { key: "layout/theme.liquid", value: "<html>" },
      }),
      "GET /themes/100/assets.json?assets/logo.png": () => ({
        asset: { key: "assets/logo.png", attachment: "QkFTRTY0" },
      }),
      "PUT /themes/300/assets.json": (opts) => {
        puts.push(opts?.body);
        return { asset: {} };
      },
    });

    const staging = await themeDuplicate(100, "staging", ctx);

    expect(staging.id).toBe(300);
    expect(puts).toEqual([
      { asset: { key: "layout/theme.liquid", value: "<html>" } },
      { asset: { key: "assets/logo.png", attachment: "QkFTRTY0" } },
    ]);
    // Creation is explicitly unpublished — never a direct live write.
    expect(mockFetch).toHaveBeenCalledWith("/themes.json", {
      method: "POST",
      body: { theme: { name: "staging", role: "unpublished" } },
      shopContext: ctx,
    });
  });

  it("deletes the half-copied theme when an asset copy fails", async () => {
    let deleted = false;
    routeFetch({
      "GET /themes/100/assets.json": () => ({
        assets: [{ key: "layout/theme.liquid" }],
      }),
      "POST /themes.json": () => ({ theme: { id: 300, role: "unpublished" } }),
      "GET /themes/100/assets.json?layout/theme.liquid": () => {
        throw new Error("boom: asset fetch failed");
      },
      "DELETE /themes/300.json": () => {
        deleted = true;
        return {};
      },
    });

    await expect(themeDuplicate(100, "staging")).rejects.toThrow(/boom/);
    expect(deleted).toBe(true);
  });

  it("still surfaces the copy error when cleanup itself fails", async () => {
    routeFetch({
      "GET /themes/100/assets.json": () => ({
        assets: [{ key: "layout/theme.liquid" }],
      }),
      "POST /themes.json": () => ({ theme: { id: 300, role: "unpublished" } }),
      "GET /themes/100/assets.json?layout/theme.liquid": () => {
        throw new Error("boom: asset fetch failed");
      },
      "DELETE /themes/300.json": () => {
        throw new Error("delete also failed");
      },
    });

    await expect(themeDuplicate(100, "staging")).rejects.toThrow(/boom/);
  });
});

describe("prepareStagingTheme", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_SHOP = "env-store.myshopify.com";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  function stagingRoutes() {
    routeFetch({
      "GET /themes.json": () => ({ themes }),
      "GET /themes/100/assets.json": () => ({
        assets: [{ key: "layout/theme.liquid" }],
      }),
      "GET /themes/200/assets.json": () => ({
        assets: [{ key: "layout/theme.liquid" }],
      }),
      "POST /themes.json": () => ({ theme: { id: 300, role: "unpublished" } }),
      "GET /themes/100/assets.json?layout/theme.liquid": () => ({
        asset: { key: "layout/theme.liquid", value: "<html>" },
      }),
      "GET /themes/200/assets.json?layout/theme.liquid": () => ({
        asset: { key: "layout/theme.liquid", value: "<html>" },
      }),
      "PUT /themes/300/assets.json": () => ({ asset: {} }),
    });
  }

  it("duplicates the published theme by default and returns the preview URL", async () => {
    stagingRoutes();
    const result = await prepareStagingTheme(undefined, "SchemaGen staging", ctx);
    expect(result).toEqual({
      stagingThemeId: 300,
      sourceThemeId: 100, // role "main" auto-detected
      previewUrl:
        "https://garnerandtow.myshopify.com/?preview_theme_id=300",
    });
  });

  it("honors an explicit source theme id", async () => {
    stagingRoutes();
    const result = await prepareStagingTheme(200, "copy", ctx);
    expect(result.sourceThemeId).toBe(200);
  });

  it("falls back to the env shop for the preview URL without a context", async () => {
    stagingRoutes();
    const result = await prepareStagingTheme(undefined, "copy");
    expect(result.previewUrl).toBe(
      "https://env-store.myshopify.com/?preview_theme_id=300"
    );
  });

  it("throws when there is no published theme to duplicate", async () => {
    routeFetch({
      "GET /themes.json": () => ({
        themes: [{ id: 200, name: "Old Dawn", role: "unpublished" }],
      }),
    });
    await expect(prepareStagingTheme(undefined, "copy", ctx)).rejects.toThrow(
      /no published .*theme found/
    );
  });

  it("throws when the explicit source id is unknown", async () => {
    routeFetch({ "GET /themes.json": () => ({ themes }) });
    await expect(prepareStagingTheme(999, "copy", ctx)).rejects.toThrow(
      /theme 999 not found/
    );
  });
});
