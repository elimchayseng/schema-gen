/**
 * Integration test: install the SchemaGen footprint on a REAL dev-store theme,
 * confirm the snippet + include land, then uninstall and confirm a clean theme.
 * This is the Phase 1 live acceptance ("a product page renders correct JSON-LD;
 * re-running is idempotent; removal leaves theme.liquid intact").
 *
 * Skipped unless RUN_SHOPIFY_INTEGRATION=1 AND the dev-store env is present
 * (SHOPIFY_SHOP, SHOPIFY_OFFLINE_TOKEN, SHOPIFY_TEST_THEME_ID). Also writes a
 * theme_backups row via the service-role client, so SUPABASE_SERVICE_ROLE_KEY +
 * migration 005 must be applied.
 *
 * Run:
 *   RUN_SHOPIFY_INTEGRATION=1 npx vitest run \
 *     src/lib/shopify/__tests__/install.integration.test.ts
 */
import { describe, it, expect } from "vitest";
import { assetGet } from "../assets";
import { getShopifyConfig } from "../config";
import {
  LAYOUT_ASSET_KEY,
  SNIPPET_ASSET_KEY,
  installSchemaGen,
  uninstallSchemaGen,
} from "../install";
import { MARKER_BLOCK } from "../theme-liquid";
import { ShopifyError } from "../client";

const enabled = process.env.RUN_SHOPIFY_INTEGRATION === "1";
const themeIdRaw = process.env.SHOPIFY_TEST_THEME_ID;
const hasEnv =
  !!process.env.SHOPIFY_SHOP &&
  !!process.env.SHOPIFY_OFFLINE_TOKEN &&
  !!themeIdRaw &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForAsset(
  themeId: number,
  key: string,
  predicate: (value: string) => boolean,
  timeoutMs = 30_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = (await assetGet(themeId, key)).value ?? "";
    if (predicate(value) || Date.now() >= deadline) return value;
    await sleep(1500);
  }
}

const PRODUCT_JSONLD = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Integration Test Widget",
  offers: {
    "@type": "Offer",
    price: "9.99",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
};

describe.skipIf(!(enabled && hasEnv))(
  "SchemaGen install round-trip (integration)",
  () => {
    it("installs snippet + include, is idempotent, then uninstalls cleanly", async () => {
      const themeId = Number(themeIdRaw);
      const { shop } = getShopifyConfig();
      const ctx = { themeId, shop };
      const before = (await assetGet(themeId, LAYOUT_ASSET_KEY)).value ?? "";

      try {
        // Install.
        await installSchemaGen(ctx, [
          { template: "product", handle: "integration-test-widget", jsonld: PRODUCT_JSONLD },
        ]);

        // Snippet landed with the product JSON-LD.
        const snippet = await waitForAsset(themeId, SNIPPET_ASSET_KEY, (v) =>
          v.includes("Integration Test Widget")
        );
        expect(snippet).toContain("product.handle == 'integration-test-widget'");

        // theme.liquid now includes the managed block.
        const withInclude = await waitForAsset(themeId, LAYOUT_ASSET_KEY, (v) =>
          v.includes(MARKER_BLOCK)
        );
        expect(withInclude).toContain(MARKER_BLOCK);

        // Idempotent: a second install leaves exactly one block.
        await installSchemaGen(ctx, [
          { template: "product", handle: "integration-test-widget", jsonld: PRODUCT_JSONLD },
        ]);
        const again = (await assetGet(themeId, LAYOUT_ASSET_KEY)).value ?? "";
        expect(again.match(/SCHEMAGEN:START/g) ?? []).toHaveLength(1);
      } finally {
        await uninstallSchemaGen(ctx);
      }

      // theme.liquid restored to its pre-install content; snippet deleted.
      const after = await waitForAsset(
        themeId,
        LAYOUT_ASSET_KEY,
        (v) => !v.includes(MARKER_BLOCK)
      );
      expect(after).toBe(before);

      await expect(assetGet(themeId, SNIPPET_ASSET_KEY)).rejects.toMatchObject({
        name: "ShopifyError",
        status: 404,
      });
      // touch ShopifyError import so it is not flagged unused
      expect(ShopifyError).toBeTypeOf("function");
    }, 180_000);
  }
);
