import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../assets", () => ({
  assetGet: vi.fn(),
  assetUpsert: vi.fn(),
  assetDelete: vi.fn(),
}));
vi.mock("../backup", () => ({
  safeAssetUpsert: vi.fn(),
}));

import { assetDelete, assetGet, assetUpsert } from "../assets";
import { safeAssetUpsert } from "../backup";
import {
  LAYOUT_ASSET_KEY,
  SNIPPET_ASSET_KEY,
  installSchemaGen,
  uninstallSchemaGen,
} from "../install";
import { MARKER_BLOCK } from "../theme-liquid";

const mockAssetGet = vi.mocked(assetGet);
const mockAssetUpsert = vi.mocked(assetUpsert);
const mockAssetDelete = vi.mocked(assetDelete);
const mockSafeUpsert = vi.mocked(safeAssetUpsert);

const ctx = { themeId: 7, shop: "s.myshopify.com", runId: "run-1" };
const LAYOUT_PLAIN = "<html><head>\n<title>x</title>\n</head><body></body></html>\n";
const LAYOUT_WITH_BLOCK = LAYOUT_PLAIN.replace(
  "</head>",
  `${MARKER_BLOCK}\n</head>`
);

describe("installSchemaGen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the snippet then adds the include to theme.liquid", async () => {
    mockAssetGet.mockResolvedValue({ key: LAYOUT_ASSET_KEY, value: LAYOUT_PLAIN });
    mockSafeUpsert.mockResolvedValue({ key: LAYOUT_ASSET_KEY });

    await installSchemaGen(ctx, [
      { template: "product", handle: "blue-widget", jsonld: { "@type": "Product" } },
    ]);

    // snippet written first
    const [themeId, key, value] = mockAssetUpsert.mock.calls[0];
    expect(themeId).toBe(7);
    expect(key).toBe(SNIPPET_ASSET_KEY);
    expect(value).toContain("product.handle == 'blue-widget'");

    // layout reconciled via safeAssetUpsert with the include present
    expect(mockSafeUpsert).toHaveBeenCalledTimes(1);
    const [params, newLayout] = mockSafeUpsert.mock.calls[0];
    expect(params).toMatchObject({
      themeId: 7,
      assetKey: LAYOUT_ASSET_KEY,
      runId: "run-1",
    });
    expect(newLayout).toContain(MARKER_BLOCK);
  });

  it("does not rewrite theme.liquid when the include is already present", async () => {
    mockAssetGet.mockResolvedValue({
      key: LAYOUT_ASSET_KEY,
      value: LAYOUT_WITH_BLOCK,
    });

    await installSchemaGen(ctx, []);

    // snippet still (re)written, but layout untouched (idempotent)
    expect(mockAssetUpsert).toHaveBeenCalledWith(
      7,
      SNIPPET_ASSET_KEY,
      expect.any(String)
    );
    expect(mockSafeUpsert).not.toHaveBeenCalled();
  });
});

describe("uninstallSchemaGen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes the include then deletes the snippet", async () => {
    mockAssetGet.mockResolvedValue({
      key: LAYOUT_ASSET_KEY,
      value: LAYOUT_WITH_BLOCK,
    });
    mockSafeUpsert.mockResolvedValue({ key: LAYOUT_ASSET_KEY });

    await uninstallSchemaGen(ctx);

    const [, newLayout] = mockSafeUpsert.mock.calls[0];
    expect(newLayout).not.toContain(MARKER_BLOCK);
    expect(mockAssetDelete).toHaveBeenCalledWith(7, SNIPPET_ASSET_KEY);
  });

  it("still deletes the snippet when theme.liquid has no include", async () => {
    mockAssetGet.mockResolvedValue({ key: LAYOUT_ASSET_KEY, value: LAYOUT_PLAIN });

    await uninstallSchemaGen(ctx);

    expect(mockSafeUpsert).not.toHaveBeenCalled();
    expect(mockAssetDelete).toHaveBeenCalledWith(7, SNIPPET_ASSET_KEY);
  });
});
