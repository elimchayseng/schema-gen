import { describe, it, expect, vi } from "vitest";
import { applyEntries, type ApplyItem, type ThemeAssetOps } from "../apply";
import { LAYOUT_ASSET_KEY, SNIPPET_ASSET_KEY } from "@/lib/shopify/install";
import { MARKER_START } from "@/lib/shopify/theme-liquid";
import type { GateResult } from "../types";

const THEME_ID = 123456;

const ORIGINAL_LAYOUT =
  "<!doctype html>\n<html>\n<head>\n  <title>Store</title>\n</head>\n<body></body>\n</html>\n";

/** In-memory theme: a key→value map that mimics ThemeAssetOps (404 = key absent). */
function makeMemoryTheme(seed: Record<string, string> = {}): {
  ops: ThemeAssetOps;
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(seed));
  const key = (themeId: number, k: string) => `${themeId}:${k}`;
  const ops: ThemeAssetOps = {
    async get(themeId, k) {
      return store.has(key(themeId, k)) ? store.get(key(themeId, k))! : null;
    },
    async put(themeId, k, v) {
      store.set(key(themeId, k), v);
    },
    async del(themeId, k) {
      store.delete(key(themeId, k));
    },
  };
  return { ops, store };
}

const item = (url: string): ApplyItem => ({
  url,
  entry: { template: "product", handle: url.split("/").pop()!, jsonld: { "@type": "Product", name: url } },
});

const passVerify = async (): Promise<GateResult> => ({ passed: true });

const seedLive = { [`${THEME_ID}:${LAYOUT_ASSET_KEY}`]: ORIGINAL_LAYOUT };

describe("applyEntries (in-place apply + atomic rollback)", () => {
  it("writes the footprint and reports applied when all L4 pass", async () => {
    const { ops, store } = makeMemoryTheme(seedLive);
    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "shop.myshopify.com",
      items: [item("https://s/products/a"), item("https://s/products/b")],
      ops,
      verify: passVerify,
    });

    expect(r.status).toBe("applied");
    expect(r.writeTarget).toBe(String(THEME_ID));
    // Footprint landed: snippet written + include in theme.liquid.
    expect(store.get(`${THEME_ID}:${SNIPPET_ASSET_KEY}`)).toContain("application/ld+json");
    expect(store.get(`${THEME_ID}:${LAYOUT_ASSET_KEY}`)).toContain(MARKER_START);
    // verify + write audit rows present.
    expect(r.actions.filter((a) => a.action === "write")).toHaveLength(1);
    expect(r.actions.filter((a) => a.action === "verify")).toHaveLength(2);
  });

  it("ACCEPTANCE: a non-rendering snippet fails L4 → rolls back BYTE-IDENTICAL", async () => {
    const { ops, store } = makeMemoryTheme(seedLive);
    const snapshot = new Map(store); // exact pre-apply bytes

    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "shop.myshopify.com",
      items: [item("https://s/products/a")],
      ops,
      // L4 fails: the live render never shows the schema.
      verify: async () => ({ passed: false, detail: "no JSON-LD rendered on the live page" }),
    });

    expect(r.status).toBe("rolled_back");
    // Theme is byte-identical to before: snippet gone (didn't exist pre-run), layout restored.
    expect(store).toEqual(snapshot);
    expect(store.has(`${THEME_ID}:${SNIPPET_ASSET_KEY}`)).toBe(false);
    expect(store.get(`${THEME_ID}:${LAYOUT_ASSET_KEY}`)).toBe(ORIGINAL_LAYOUT);
    expect(r.actions.some((a) => a.action === "rollback" && a.outcome.startsWith("rolled_back"))).toBe(true);
  });

  it("restores a PRE-EXISTING snippet to its exact prior value (not delete) on rollback", async () => {
    const priorSnippet = "{%- comment -%} old schemagen {%- endcomment -%}\n";
    const { ops, store } = makeMemoryTheme({
      ...seedLive,
      [`${THEME_ID}:${SNIPPET_ASSET_KEY}`]: priorSnippet,
    });
    const snapshot = new Map(store);

    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify: async () => ({ passed: false, detail: "fail" }),
    });

    expect(r.status).toBe("rolled_back");
    expect(store).toEqual(snapshot);
    expect(store.get(`${THEME_ID}:${SNIPPET_ASSET_KEY}`)).toBe(priorSnippet);
  });

  it("ACCEPTANCE: rollback failure → status paged (theme left dirty), does not throw", async () => {
    const { ops } = makeMemoryTheme(seedLive);
    // Make the restore write fail.
    const realPut = ops.put;
    let firstPutDone = false;
    ops.put = vi.fn(async (themeId: number, k: string, v: string) => {
      // Allow the forward write; fail when restore tries to put the layout back.
      if (firstPutDone && k === LAYOUT_ASSET_KEY) {
        throw new Error("Shopify 500 on restore");
      }
      if (k === LAYOUT_ASSET_KEY) firstPutDone = true;
      return realPut(themeId, k, v);
    }) as ThemeAssetOps["put"];

    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify: async () => ({ passed: false, detail: "fail" }),
    });

    expect(r.status).toBe("paged");
    expect(r.error).toMatch(/Shopify 500 on restore/);
    expect(r.actions.some((a) => a.action === "rollback" && a.outcome.startsWith("rollback_failed"))).toBe(true);
  });

  it("rolls back BYTE-IDENTICAL when a forward write throws (not just on L4 failure)", async () => {
    const { ops, store } = makeMemoryTheme(seedLive);
    const snapshot = new Map(store);
    const realPut = ops.put;
    // The FORWARD layout write throws once (transient Shopify 500); the later restore
    // write succeeds — proving a write error still rolls back cleanly.
    let layoutWrites = 0;
    ops.put = vi.fn(async (themeId: number, k: string, v: string) => {
      if (k === LAYOUT_ASSET_KEY && layoutWrites++ === 0) {
        throw new Error("Shopify 500 on layout write");
      }
      return realPut(themeId, k, v);
    }) as ThemeAssetOps["put"];

    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify: passVerify, // L4 never reached; the write failed first
    });

    expect(r.status).toBe("rolled_back");
    expect(r.actions.some((a) => a.action === "rollback" && a.outcome.includes("write error"))).toBe(true);
    // The snippet that DID land is removed → byte-identical to before.
    expect(store).toEqual(snapshot);
    expect(store.has(`${THEME_ID}:${SNIPPET_ASSET_KEY}`)).toBe(false);
  });

  it("backs up BEFORE the first write (ordering)", async () => {
    const { ops } = makeMemoryTheme(seedLive);
    const calls: string[] = [];
    const realGet = ops.get;
    const realPut = ops.put;
    ops.get = (async (t: number, k: string) => {
      calls.push(`get:${k}`);
      return realGet(t, k);
    }) as ThemeAssetOps["get"];
    ops.put = (async (t: number, k: string, v: string) => {
      calls.push(`put:${k}`);
      return realPut(t, k, v);
    }) as ThemeAssetOps["put"];

    await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify: passVerify,
    });

    const firstPut = calls.findIndex((c) => c.startsWith("put:"));
    const layoutGet = calls.indexOf(`get:${LAYOUT_ASSET_KEY}`);
    const snippetGet = calls.indexOf(`get:${SNIPPET_ASSET_KEY}`);
    expect(layoutGet).toBeGreaterThanOrEqual(0);
    expect(snippetGet).toBeGreaterThanOrEqual(0);
    expect(layoutGet).toBeLessThan(firstPut); // both backups happen before any write
    expect(snippetGet).toBeLessThan(firstPut);
  });

  it("persists backups (best-effort) and never aborts on a backup-write failure", async () => {
    const { ops, store } = makeMemoryTheme(seedLive);
    const persistBackup = vi.fn(async () => {
      throw new Error("theme_backups unreachable");
    });

    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify: passVerify,
      persistBackup,
    });

    expect(persistBackup).toHaveBeenCalledTimes(2); // layout + snippet
    expect(r.status).toBe("applied"); // backup failure did not abort
    expect(store.get(`${THEME_ID}:${SNIPPET_ASSET_KEY}`)).toBeDefined();
  });

  it("no items → applied no-op, nothing written", async () => {
    const { ops, store } = makeMemoryTheme(seedLive);
    const snapshot = new Map(store);
    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [],
      ops,
      verify: passVerify,
    });
    expect(r.status).toBe("applied");
    expect(r.writeTarget).toBeNull();
    expect(store).toEqual(snapshot);
  });

  it("throws if theme.liquid is missing (bad themeId)", async () => {
    const { ops } = makeMemoryTheme({}); // empty theme
    await expect(
      applyEntries({
        runId: "run-1",
        themeId: THEME_ID,
        shop: "s",
        items: [item("https://s/products/a")],
        ops,
        verify: passVerify,
      })
    ).rejects.toThrow(/not found on theme/);
  });
});
