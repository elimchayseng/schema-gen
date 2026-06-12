import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../client", () => ({
  shopifyFetch: vi.fn(),
}));

import { shopifyFetch } from "../client";
import {
  assetDelete,
  assetGet,
  assetPut,
  assetsList,
  assetUpsert,
  listThemes,
  themeCreate,
  themeDelete,
  themeGet,
  themePublish,
} from "../assets";
import type { ShopContext } from "../types";

const mockFetch = vi.mocked(shopifyFetch);

const ctx: ShopContext = {
  shop: "garnerandtow.myshopify.com",
  credentials: { appKey: "k", appSecret: "s" },
};

describe("assets", () => {
  beforeEach(() => vi.clearAllMocks());

  it("themeGet unwraps { theme }", async () => {
    mockFetch.mockResolvedValue({ theme: { id: 5, name: "T", role: "main" } });
    const theme = await themeGet(5);
    expect(theme.id).toBe(5);
    expect(mockFetch).toHaveBeenCalledWith("/themes/5.json", {});
  });

  it("listThemes unwraps { themes }", async () => {
    mockFetch.mockResolvedValue({ themes: [{ id: 1 }, { id: 2 }] });
    const themes = await listThemes();
    expect(themes).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledWith("/themes.json", {});
  });

  it("themeCreate posts an unpublished theme", async () => {
    mockFetch.mockResolvedValue({ theme: { id: 99, role: "unpublished" } });
    await themeCreate("SchemaGen staging");
    expect(mockFetch).toHaveBeenCalledWith("/themes.json", {
      method: "POST",
      body: { theme: { name: "SchemaGen staging", role: "unpublished" } },
    });
  });

  it("themeCreate includes src when provided", async () => {
    mockFetch.mockResolvedValue({ theme: { id: 99 } });
    await themeCreate("copy", "https://example.com/theme.zip");
    expect(mockFetch).toHaveBeenCalledWith("/themes.json", {
      method: "POST",
      body: {
        theme: {
          name: "copy",
          role: "unpublished",
          src: "https://example.com/theme.zip",
        },
      },
    });
  });

  it("themeDelete DELETEs the theme", async () => {
    mockFetch.mockResolvedValue({});
    await themeDelete(7);
    expect(mockFetch).toHaveBeenCalledWith("/themes/7.json", {
      method: "DELETE",
    });
  });

  it("assetsList unwraps { assets } (metadata listing)", async () => {
    mockFetch.mockResolvedValue({
      assets: [{ key: "layout/theme.liquid" }, { key: "assets/logo.png" }],
    });
    const assets = await assetsList(5);
    expect(assets.map((a) => a.key)).toEqual([
      "layout/theme.liquid",
      "assets/logo.png",
    ]);
    expect(mockFetch).toHaveBeenCalledWith("/themes/5/assets.json", {});
  });

  it("assetGet queries by asset[key]", async () => {
    mockFetch.mockResolvedValue({
      asset: { key: "layout/theme.liquid", value: "<html>" },
    });
    const asset = await assetGet(5, "layout/theme.liquid");
    expect(asset.value).toBe("<html>");
    expect(mockFetch).toHaveBeenCalledWith("/themes/5/assets.json", {
      query: { "asset[key]": "layout/theme.liquid" },
    });
  });

  it("assetUpsert PUTs the asset body", async () => {
    mockFetch.mockResolvedValue({ asset: { key: "k", value: "v" } });
    await assetUpsert(5, "k", "v");
    expect(mockFetch).toHaveBeenCalledWith("/themes/5/assets.json", {
      method: "PUT",
      body: { asset: { key: "k", value: "v" } },
    });
  });

  it("assetPut carries a binary attachment body", async () => {
    mockFetch.mockResolvedValue({ asset: { key: "assets/logo.png" } });
    await assetPut(5, { key: "assets/logo.png", attachment: "QkFTRTY0" });
    expect(mockFetch).toHaveBeenCalledWith("/themes/5/assets.json", {
      method: "PUT",
      body: { asset: { key: "assets/logo.png", attachment: "QkFTRTY0" } },
    });
  });

  it("assetDelete DELETEs by asset[key]", async () => {
    mockFetch.mockResolvedValue({});
    await assetDelete(5, "snippets/schemagen-jsonld.liquid");
    expect(mockFetch).toHaveBeenCalledWith("/themes/5/assets.json", {
      method: "DELETE",
      query: { "asset[key]": "snippets/schemagen-jsonld.liquid" },
    });
  });

  it("themePublish sets role main", async () => {
    mockFetch.mockResolvedValue({ theme: { id: 5, role: "main" } });
    await themePublish(5);
    expect(mockFetch).toHaveBeenCalledWith("/themes/5.json", {
      method: "PUT",
      body: { theme: { id: 5, role: "main" } },
    });
  });

  it("threads a ShopContext through to shopifyFetch (issue #25)", async () => {
    mockFetch.mockResolvedValue({ theme: { id: 5 } });
    await themeGet(5, ctx);
    expect(mockFetch).toHaveBeenCalledWith("/themes/5.json", {
      shopContext: ctx,
    });

    mockFetch.mockResolvedValue({ asset: { key: "k", value: "v" } });
    await assetUpsert(5, "k", "v", undefined, ctx);
    expect(mockFetch).toHaveBeenLastCalledWith("/themes/5/assets.json", {
      method: "PUT",
      body: { asset: { key: "k", value: "v" } },
      shopContext: ctx,
    });

    mockFetch.mockResolvedValue({ theme: { id: 5, role: "main" } });
    await themePublish(5, ctx);
    expect(mockFetch).toHaveBeenLastCalledWith("/themes/5.json", {
      method: "PUT",
      body: { theme: { id: 5, role: "main" } },
      shopContext: ctx,
    });
  });
});
