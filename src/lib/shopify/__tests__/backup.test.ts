import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted supabase chain mock: createAdminClient().from().insert().select().single()
const h = vi.hoisted(() => {
  const single = vi.fn();
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ insert }));
  const createAdminClient = vi.fn(() => ({ from }));
  return { single, select, insert, from, createAdminClient };
});

vi.mock("@/lib/supabase", () => ({ createAdminClient: h.createAdminClient }));
vi.mock("../assets", () => ({
  assetGet: vi.fn(),
  assetUpsert: vi.fn(),
}));

import { assetGet, assetUpsert } from "../assets";
import { backupAsset, restoreAsset, safeAssetUpsert } from "../backup";
import type { ThemeBackup } from "../types";

const mockAssetGet = vi.mocked(assetGet);
const mockAssetUpsert = vi.mocked(assetUpsert);

const params = {
  runId: "run-1",
  shop: "my-store.myshopify.com",
  themeId: 42,
  assetKey: "layout/theme.liquid",
};

const backupRow: ThemeBackup = {
  id: "backup-1",
  run_id: "run-1",
  shop: "my-store.myshopify.com",
  theme_id: 42,
  asset_key: "layout/theme.liquid",
  asset_value_before: "ORIGINAL",
  created_at: "2026-06-06T00:00:00Z",
};

describe("backupAsset", () => {
  beforeEach(() => vi.clearAllMocks());

  it("snapshots the current asset value into theme_backups", async () => {
    mockAssetGet.mockResolvedValue({
      key: "layout/theme.liquid",
      value: "ORIGINAL",
    });
    h.single.mockResolvedValue({ data: backupRow, error: null });

    const result = await backupAsset(params);

    expect(mockAssetGet).toHaveBeenCalledWith(42, "layout/theme.liquid");
    expect(h.from).toHaveBeenCalledWith("theme_backups");
    expect(h.insert).toHaveBeenCalledWith({
      run_id: "run-1",
      shop: "my-store.myshopify.com",
      theme_id: 42,
      asset_key: "layout/theme.liquid",
      asset_value_before: "ORIGINAL",
    });
    expect(result).toBe(backupRow);
  });

  it("stores an empty string when the asset has no value", async () => {
    mockAssetGet.mockResolvedValue({ key: "layout/theme.liquid" });
    h.single.mockResolvedValue({ data: backupRow, error: null });

    await backupAsset(params);

    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({ asset_value_before: "" })
    );
  });

  it("defaults run_id to null when omitted", async () => {
    mockAssetGet.mockResolvedValue({ key: "k", value: "v" });
    h.single.mockResolvedValue({ data: backupRow, error: null });

    await backupAsset({ shop: "s.myshopify.com", themeId: 1, assetKey: "k" });

    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: null })
    );
  });

  it("throws when the insert fails", async () => {
    mockAssetGet.mockResolvedValue({ key: "k", value: "v" });
    h.single.mockResolvedValue({ data: null, error: { message: "boom" } });

    await expect(backupAsset(params)).rejects.toThrow(
      /Failed to write theme_backups: boom/
    );
  });
});

describe("restoreAsset", () => {
  beforeEach(() => vi.clearAllMocks());

  it("re-upserts the exact prior value with a bounded retry", async () => {
    mockAssetUpsert.mockResolvedValue({ key: "layout/theme.liquid" });
    await restoreAsset(backupRow);
    expect(mockAssetUpsert).toHaveBeenCalledWith(
      42,
      "layout/theme.liquid",
      "ORIGINAL",
      { maxRetries: 2 }
    );
  });
});

describe("safeAssetUpsert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssetGet.mockResolvedValue({
      key: "layout/theme.liquid",
      value: "ORIGINAL",
    });
    h.single.mockResolvedValue({ data: backupRow, error: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes the new value and does not restore on success", async () => {
    mockAssetUpsert.mockResolvedValue({ key: "layout/theme.liquid" });

    await safeAssetUpsert(params, "NEW VALUE");

    // exactly one write, with the new value; no restore
    expect(mockAssetUpsert).toHaveBeenCalledTimes(1);
    expect(mockAssetUpsert).toHaveBeenCalledWith(
      42,
      "layout/theme.liquid",
      "NEW VALUE"
    );
  });

  it("restores from backup and rethrows when the write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockAssetUpsert
      .mockRejectedValueOnce(new Error("write failed")) // the write
      .mockResolvedValueOnce({ key: "layout/theme.liquid" }); // the restore

    await expect(safeAssetUpsert(params, "NEW VALUE")).rejects.toThrow(
      "write failed"
    );

    expect(mockAssetUpsert).toHaveBeenCalledTimes(2);
    // first call: the attempted write
    expect(mockAssetUpsert).toHaveBeenNthCalledWith(
      1,
      42,
      "layout/theme.liquid",
      "NEW VALUE"
    );
    // second call: the restore to the original value (bounded retry)
    expect(mockAssetUpsert).toHaveBeenNthCalledWith(
      2,
      42,
      "layout/theme.liquid",
      "ORIGINAL",
      { maxRetries: 2 }
    );
  });

  it("when write AND restore both fail, throws a dirty-state error preserving the write error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const writeErr = new Error("write failed");
    mockAssetUpsert
      .mockRejectedValueOnce(writeErr) // the write
      .mockRejectedValueOnce(new Error("restore failed")); // the restore

    const err = await safeAssetUpsert(params, "NEW VALUE").catch((e) => e);

    expect(err).toMatchObject({
      name: "ShopifyError",
      rollbackFailed: true,
      cause: writeErr,
    });
    // the surfaced error names the dirty theme and both failures
    expect(err.message).toMatch(
      /left dirty.*write failed.*restore: restore failed/
    );
    expect(mockAssetUpsert).toHaveBeenCalledTimes(2);
  });
});
