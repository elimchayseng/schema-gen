/**
 * Shopify Theme + Asset API operations (agent Phase 0).
 * Thin typed wrappers over shopifyFetch. The Asset API is REST:
 *   GET    /themes/{id}.json
 *   GET    /themes.json
 *   POST   /themes.json                     (create / "duplicate")
 *   GET    /themes/{id}/assets.json?asset[key]=...
 *   PUT    /themes/{id}/assets.json         { asset: { key, value } }
 *   DELETE /themes/{id}/assets.json?asset[key]=...
 *   PUT    /themes/{id}.json                { theme: { id, role: "main" } }
 */
import { shopifyFetch, type ShopifyFetchOptions } from "./client";
import type { ShopifyAsset, ShopifyTheme } from "./types";

export async function themeGet(themeId: number): Promise<ShopifyTheme> {
  const res = await shopifyFetch<{ theme: ShopifyTheme }>(
    `/themes/${themeId}.json`
  );
  return res.theme;
}

export async function listThemes(): Promise<ShopifyTheme[]> {
  const res = await shopifyFetch<{ themes: ShopifyTheme[] }>(`/themes.json`);
  return res.themes;
}

/**
 * Create a new unpublished theme, optionally from a source zip URL.
 *
 * Phase 0 is thin on purpose (see eng review decision D2): Shopify has no clean
 * REST "duplicate theme N" call. The real staging workflow — duplicate the live
 * theme, write to the copy, L4 live-verify, then publish/swap — is built and
 * live-verified in Phase 3. This function gives Phase 3 its create primitive.
 */
export async function themeDuplicate(
  name: string,
  src?: string
): Promise<ShopifyTheme> {
  const res = await shopifyFetch<{ theme: ShopifyTheme }>(`/themes.json`, {
    method: "POST",
    body: { theme: { name, role: "unpublished", ...(src ? { src } : {}) } },
  });
  return res.theme;
}

export async function assetGet(
  themeId: number,
  key: string
): Promise<ShopifyAsset> {
  const res = await shopifyFetch<{ asset: ShopifyAsset }>(
    `/themes/${themeId}/assets.json`,
    { query: { "asset[key]": key } }
  );
  return res.asset;
}

export async function assetUpsert(
  themeId: number,
  key: string,
  value: string,
  retry?: ShopifyFetchOptions["retry"]
): Promise<ShopifyAsset> {
  const res = await shopifyFetch<{ asset: ShopifyAsset }>(
    `/themes/${themeId}/assets.json`,
    { method: "PUT", body: { asset: { key, value } }, ...(retry ? { retry } : {}) }
  );
  return res.asset;
}

export async function assetDelete(
  themeId: number,
  key: string
): Promise<void> {
  await shopifyFetch(`/themes/${themeId}/assets.json`, {
    method: "DELETE",
    query: { "asset[key]": key },
  });
}

/** Publish a theme (set role to "main" / live). */
export async function themePublish(themeId: number): Promise<ShopifyTheme> {
  const res = await shopifyFetch<{ theme: ShopifyTheme }>(
    `/themes/${themeId}.json`,
    { method: "PUT", body: { theme: { id: themeId, role: "main" } } }
  );
  return res.theme;
}
