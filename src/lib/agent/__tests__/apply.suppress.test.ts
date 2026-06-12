/**
 * Suppression in the apply path (issue #23 integration). applyEntries gains an
 * optional `suppressions` plan; this suite proves:
 *   - a suppressible competing emission is rewritten + audited + reported,
 *   - a not-suppressible one becomes a merchant_action row and the apply CONTINUES,
 *   - an L4 failure after suppression restores the suppressed asset BYTE-IDENTICAL
 *     via the same atomic rollback that covers theme.liquid/snippet,
 *   - omitting the param keeps legacy behavior byte-identical (apply.test.ts also
 *     guards this — it must pass unchanged).
 */
import { describe, it, expect, vi } from "vitest";
import {
  applyEntries,
  type ApplyItem,
  type ApplySuppression,
  type ThemeAssetOps,
} from "../apply";
import { LAYOUT_ASSET_KEY, SNIPPET_ASSET_KEY } from "@/lib/shopify/install";
import {
  SUPPRESS_PREFIX,
  suppressJsonLdEmission,
  unsuppressAll,
} from "@/lib/shopify/suppress";
import type { GateResult } from "../types";

const THEME_ID = 123456;

const ORIGINAL_LAYOUT =
  "<!doctype html>\n<html>\n<head>\n  <title>Store</title>\n</head>\n<body></body>\n</html>\n";

const SECTION_KEY = "sections/main-product.liquid";
const SECTION_WITH_JSONLD =
  '<div>{{ product.title }}</div>\n<script type="application/ld+json">\n' +
  '{ "@type": "Product", "name": {{ product.title | json }} }\n' +
  "</script>\n<footer></footer>\n";

const RAW_SECTION_KEY = "sections/raw-jsonld.liquid";
// {% raw %} inside the script region → statically unverifiable → not suppressible.
const SECTION_NOT_SUPPRESSIBLE =
  '<script type="application/ld+json">{% raw %}{ "@type": "Product" }{% endraw %}</script>\n';

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
  entry: {
    template: "product",
    handle: url.split("/").pop()!,
    jsonld: { "@type": "Product", name: url },
  },
});

const passVerify = async (): Promise<GateResult> => ({ passed: true });

const seedLive = {
  [`${THEME_ID}:${LAYOUT_ASSET_KEY}`]: ORIGINAL_LAYOUT,
  [`${THEME_ID}:${SECTION_KEY}`]: SECTION_WITH_JSONLD,
};

const suppression = (
  over: Partial<ApplySuppression> = {}
): ApplySuppression => ({
  assetKey: SECTION_KEY,
  match: { index: 0 },
  url: "https://s/products/a",
  ...over,
});

describe("applyEntries with suppressions (issue #23)", () => {
  it("suppresses the competing emission: asset rewritten + suppressedAssets + audit rows", async () => {
    const { ops, store } = makeMemoryTheme(seedLive);

    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify: passVerify,
      suppressions: [suppression()],
    });

    expect(r.status).toBe("applied");
    expect(r.suppressedAssets).toEqual([SECTION_KEY]);

    // The asset was rewritten with the reversible wrapper, original bytes intact inside.
    const after = store.get(`${THEME_ID}:${SECTION_KEY}`)!;
    expect(after).toContain(SUPPRESS_PREFIX);
    expect(unsuppressAll(after)).toBe(SECTION_WITH_JSONLD);

    // Audit row: action "suppress", outcome names the asset, writeTarget = theme.
    const row = r.actions.find((a) => a.action === "suppress");
    expect(row).toMatchObject({
      url: "https://s/products/a",
      outcome: `suppressed:${SECTION_KEY}`,
      writeTarget: String(THEME_ID),
    });
  });

  it("passes unique:true to the verify callback when suppressions were requested", async () => {
    const { ops } = makeMemoryTheme(seedLive);
    const verify = vi.fn(passVerify);

    await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify,
      suppressions: [suppression()],
    });

    expect(verify).toHaveBeenCalledWith(
      "https://s/products/a",
      expect.anything(),
      { unique: true }
    );
  });

  it("passes unique:false (and no suppressedAssets) when no suppressions param", async () => {
    const { ops } = makeMemoryTheme(seedLive);
    const verify = vi.fn(passVerify);

    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify,
    });

    expect(r.status).toBe("applied");
    expect(r.suppressedAssets).toBeUndefined();
    expect(verify).toHaveBeenCalledWith(
      "https://s/products/a",
      expect.anything(),
      { unique: false }
    );
    expect(r.actions.some((a) => a.action === "suppress")).toBe(false);
    expect(r.actions.some((a) => a.action === "merchant_action")).toBe(false);
  });

  it("not-suppressible region → merchant_action row, apply CONTINUES and applies", async () => {
    const { ops, store } = makeMemoryTheme({
      ...seedLive,
      [`${THEME_ID}:${RAW_SECTION_KEY}`]: SECTION_NOT_SUPPRESSIBLE,
    });

    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify: passVerify,
      suppressions: [
        suppression({ assetKey: RAW_SECTION_KEY }),
        suppression(), // the safe one still suppresses
      ],
    });

    expect(r.status).toBe("applied");
    // The unsafe asset was NOT touched.
    expect(store.get(`${THEME_ID}:${RAW_SECTION_KEY}`)).toBe(
      SECTION_NOT_SUPPRESSIBLE
    );
    const ma = r.actions.find((a) => a.action === "merchant_action");
    expect(ma?.outcome).toMatch(
      new RegExp(`^not_suppressible:${RAW_SECTION_KEY}:.*raw`)
    );
    // The safe suppression still happened.
    expect(r.suppressedAssets).toEqual([SECTION_KEY]);
  });

  it("already-suppressed target → 'already_suppressed' suppress row, NO write, not in suppressedAssets", async () => {
    // Idempotent re-run on a reused staging theme: the target's emission is
    // already wrapped, so suppressJsonLdEmission returns changed:false. The fix
    // this pins: the row MUST still be recorded (the report derives "authoritative
    // ran" from suppress rows — the old silent skip made a published run claim the
    // theme still emits competing schema), while the asset is never re-written.
    const pre = suppressJsonLdEmission(SECTION_WITH_JSONLD, { match: { index: 0 } });
    if (!pre.ok) throw new Error("fixture: pre-suppression failed");
    const alreadySuppressed = pre.text;
    const { ops, store } = makeMemoryTheme({
      ...seedLive,
      [`${THEME_ID}:${SECTION_KEY}`]: alreadySuppressed,
    });
    const puts: string[] = [];
    const realPut = ops.put;
    ops.put = (async (t: number, k: string, v: string) => {
      puts.push(k);
      return realPut(t, k, v);
    }) as ThemeAssetOps["put"];

    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify: passVerify,
      suppressions: [suppression()],
    });

    expect(r.status).toBe("applied");
    // Audited as a suppress action with the already_suppressed outcome.
    const row = r.actions.find((a) => a.action === "suppress");
    expect(row?.outcome.startsWith("already_suppressed:")).toBe(true);
    expect(row).toMatchObject({
      url: "https://s/products/a",
      outcome: `already_suppressed:${SECTION_KEY}`,
      writeTarget: String(THEME_ID),
    });
    // No put() for the section — only the footprint (snippet/layout) was written.
    expect(puts).not.toContain(SECTION_KEY);
    expect(store.get(`${THEME_ID}:${SECTION_KEY}`)).toBe(alreadySuppressed);
    // Not newly suppressed this run, so not in suppressedAssets.
    expect(r.suppressedAssets).toEqual([]);
    expect(r.actions.some((a) => a.action === "merchant_action")).toBe(false);
  });

  it("missing suppression target asset → merchant_action row, apply continues", async () => {
    const { ops } = makeMemoryTheme(seedLive);

    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify: passVerify,
      suppressions: [suppression({ assetKey: "sections/ghost.liquid" })],
    });

    expect(r.status).toBe("applied");
    expect(r.suppressedAssets).toEqual([]);
    const ma = r.actions.find((a) => a.action === "merchant_action");
    expect(ma?.outcome).toBe(
      "not_suppressible:sections/ghost.liquid:asset not found on theme"
    );
  });

  it("ACCEPTANCE: L4 failure after suppression → suppressed asset restored BYTE-IDENTICAL", async () => {
    const { ops, store } = makeMemoryTheme(seedLive);
    const snapshot = new Map(store); // exact pre-apply bytes, section included

    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify: async () => ({
        passed: false,
        detail: "duplicate schema: 2 valid 'Product' blocks in the live render",
      }),
      suppressions: [suppression()],
    });

    expect(r.status).toBe("rolled_back");
    // EVERYTHING back: layout, snippet (gone), and the suppressed section's exact bytes.
    expect(store).toEqual(snapshot);
    expect(store.get(`${THEME_ID}:${SECTION_KEY}`)).toBe(SECTION_WITH_JSONLD);
    // The rollback audit names the restored suppressed asset.
    expect(
      r.actions.some(
        (a) =>
          a.action === "rollback" &&
          a.outcome === `restored_suppressed:${SECTION_KEY}`
      )
    ).toBe(true);
    expect(
      r.actions.some(
        (a) => a.action === "rollback" && a.outcome.startsWith("rolled_back")
      )
    ).toBe(true);
  });

  it("backs up the suppression target BEFORE the first write (ordering)", async () => {
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
      suppressions: [suppression()],
    });

    const firstPut = calls.findIndex((c) => c.startsWith("put:"));
    const sectionGet = calls.indexOf(`get:${SECTION_KEY}`);
    expect(sectionGet).toBeGreaterThanOrEqual(0);
    expect(sectionGet).toBeLessThan(firstPut);
  });

  it("a thrown suppression write still rolls back the whole footprint byte-identical", async () => {
    const { ops, store } = makeMemoryTheme(seedLive);
    const snapshot = new Map(store);
    const realPut = ops.put;
    let sectionPuts = 0;
    ops.put = (async (t: number, k: string, v: string) => {
      if (k === SECTION_KEY && sectionPuts++ === 0) {
        throw new Error("Shopify 500 on section write");
      }
      return realPut(t, k, v);
    }) as ThemeAssetOps["put"];

    const r = await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify: passVerify, // never reached
      suppressions: [suppression()],
    });

    expect(r.status).toBe("rolled_back");
    expect(store).toEqual(snapshot);
    // The attempted-write asset is named in the rollback audit even though the put threw.
    expect(
      r.actions.some(
        (a) =>
          a.action === "rollback" &&
          a.outcome === `restored_suppressed:${SECTION_KEY}`
      )
    ).toBe(true);
  });

  it("persists a best-effort backup row for the suppression target", async () => {
    const { ops } = makeMemoryTheme(seedLive);
    const persistBackup = vi.fn(async () => {});

    await applyEntries({
      runId: "run-1",
      themeId: THEME_ID,
      shop: "s",
      items: [item("https://s/products/a")],
      ops,
      verify: passVerify,
      persistBackup,
      suppressions: [suppression()],
    });

    expect(persistBackup).toHaveBeenCalledWith(SECTION_KEY, SECTION_WITH_JSONLD);
  });
});
