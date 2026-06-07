/**
 * Integration test: prove safe read → write → verify → restore against a REAL
 * Shopify development store theme. This is the Phase 0 acceptance test.
 *
 * Skipped unless RUN_SHOPIFY_INTEGRATION=1 AND the dev-store env is present:
 *   SHOPIFY_SHOP, SHOPIFY_OFFLINE_TOKEN, SHOPIFY_TEST_THEME_ID
 * (set in .env.local). Never points at a published/live theme — use a
 * duplicated, unpublished theme id in SHOPIFY_TEST_THEME_ID.
 *
 * Run with:
 *   RUN_SHOPIFY_INTEGRATION=1 npx vitest run \
 *     src/lib/shopify/__tests__/asset-roundtrip.integration.test.ts
 */
import { describe, it, expect } from "vitest";
import { assetGet, assetUpsert } from "../assets";

const enabled = process.env.RUN_SHOPIFY_INTEGRATION === "1";
const themeIdRaw = process.env.SHOPIFY_TEST_THEME_ID;
const hasEnv =
  !!process.env.SHOPIFY_SHOP &&
  !!process.env.SHOPIFY_OFFLINE_TOKEN &&
  !!themeIdRaw;

const ASSET_KEY = "layout/theme.liquid";
const MARKER = "<!-- SCHEMAGEN:INTEGRATION_TEST -->";

describe.skipIf(!(enabled && hasEnv))(
  "Shopify asset round-trip (integration)",
  () => {
    it("reads, writes a no-op marker, verifies, and restores byte-identical", async () => {
      const themeId = Number(themeIdRaw);
      expect(Number.isFinite(themeId)).toBe(true);

      // 1. Read the original theme.liquid.
      const before = await assetGet(themeId, ASSET_KEY);
      const original = before.value ?? "";
      expect(original.length).toBeGreaterThan(0);

      try {
        // 2. Write a no-op marker (inside an HTML comment — renders nothing).
        const mutated = `${original}\n${MARKER}`;
        await assetUpsert(themeId, ASSET_KEY, mutated);

        // 3. Verify the marker is present on re-fetch.
        const after = await assetGet(themeId, ASSET_KEY);
        expect(after.value ?? "").toContain(MARKER);
      } finally {
        // 4. Restore the original, byte-identical, even if an assertion failed.
        await assetUpsert(themeId, ASSET_KEY, original);
      }

      // 5. Confirm the restore is byte-identical.
      const restored = await assetGet(themeId, ASSET_KEY);
      expect(restored.value ?? "").toBe(original);
    }, 60_000);
  }
);
