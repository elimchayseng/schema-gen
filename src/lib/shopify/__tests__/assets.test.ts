import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../client", () => ({
  shopifyFetch: vi.fn(),
}));

import { shopifyFetch } from "../client";
import {
  assetDelete,
  assetGet,
  assetUpsert,
  listThemes,
  themeDuplicate,
  themeGet,
  themePublish,
} from "../assets";

const mockFetch = vi.mocked(shopifyFetch);

describe("assets", () => {
  beforeEach(() => vi.clearAllMocks());

  it("themeGet unwraps { theme }", async () => {
    mockFetch.mockResolvedValue({ theme: { id: 5, name: "T", role: "main" } });
    const theme = await themeGet(5);
    expect(theme.id).toBe(5);
    expect(mockFetch).toHaveBeenCalledWith("/themes/5.json");
  });

  it("listThemes unwraps { themes }", async () => {
    mockFetch.mockResolvedValue({ themes: [{ id: 1 }, { id: 2 }] });
    const themes = await listThemes();
    expect(themes).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledWith("/themes.json");
  });

  it("themeDuplicate posts an unpublished theme", async () => {
    mockFetch.mockResolvedValue({ theme: { id: 99, role: "unpublished" } });
    await themeDuplicate("SchemaGen staging");
    expect(mockFetch).toHaveBeenCalledWith("/themes.json", {
      method: "POST",
      body: { theme: { name: "SchemaGen staging", role: "unpublished" } },
    });
  });

  it("themeDuplicate includes src when provided", async () => {
    mockFetch.mockResolvedValue({ theme: { id: 99 } });
    await themeDuplicate("copy", "https://example.com/theme.zip");
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
});
