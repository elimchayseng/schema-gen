/**
 * Shopify Theme + Asset API operations (agent Phase 0; per-shop since #25).
 * Thin typed wrappers over shopifyFetch. The Asset API is REST:
 *   GET    /themes/{id}.json
 *   GET    /themes.json
 *   POST   /themes.json                     (create, optionally from a src zip)
 *   DELETE /themes/{id}.json
 *   GET    /themes/{id}/assets.json         (metadata listing, no contents)
 *   GET    /themes/{id}/assets.json?asset[key]=...
 *   PUT    /themes/{id}/assets.json         { asset: { key, value | attachment } }
 *   DELETE /themes/{id}/assets.json?asset[key]=...
 *   PUT    /themes/{id}.json                { theme: { id, role: "main" } }
 *
 * Every function takes an optional trailing ShopContext (issue #25). Without
 * it, calls hit the env-configured shop exactly as before.
 *
 * For the staged-write safety layer (true duplicate of the live theme,
 * published-write guard, staging preparation) see themes.ts.
 */
import { shopifyFetch, type ShopifyFetchOptions } from "./client";
import type { ShopContext, ShopifyAsset, ShopifyTheme } from "./types";

/** Merge an optional per-shop context into fetch options. */
function withCtx(
  opts: ShopifyFetchOptions,
  ctx?: ShopContext
): ShopifyFetchOptions {
  return ctx ? { ...opts, shopContext: ctx } : opts;
}

export async function themeGet(
  themeId: number,
  ctx?: ShopContext
): Promise<ShopifyTheme> {
  const res = await shopifyFetch<{ theme: ShopifyTheme }>(
    `/themes/${themeId}.json`,
    withCtx({}, ctx)
  );
  return res.theme;
}

export async function listThemes(ctx?: ShopContext): Promise<ShopifyTheme[]> {
  const res = await shopifyFetch<{ themes: ShopifyTheme[] }>(
    `/themes.json`,
    withCtx({}, ctx)
  );
  return res.themes;
}

/**
 * Create a new unpublished theme, optionally from a source zip URL.
 *
 * This is the create primitive (formerly exported as `themeDuplicate`, renamed
 * in #26 because it never duplicated anything — Shopify has no REST
 * "duplicate theme N" call). The real duplicate — copy every asset of an
 * existing theme into a fresh unpublished one — is themes.ts#themeDuplicate.
 */
export async function themeCreate(
  name: string,
  src?: string,
  ctx?: ShopContext
): Promise<ShopifyTheme> {
  const res = await shopifyFetch<{ theme: ShopifyTheme }>(
    `/themes.json`,
    withCtx(
      {
        method: "POST",
        body: { theme: { name, role: "unpublished", ...(src ? { src } : {}) } },
      },
      ctx
    )
  );
  return res.theme;
}

/** Delete a theme (used to clean up a half-copied staging theme). */
export async function themeDelete(
  themeId: number,
  ctx?: ShopContext
): Promise<void> {
  await shopifyFetch(`/themes/${themeId}.json`, withCtx({ method: "DELETE" }, ctx));
}

/**
 * List every asset of a theme. Returns metadata only (key, content_type,
 * size, …) — fetch contents per asset via assetGet.
 */
export async function assetsList(
  themeId: number,
  ctx?: ShopContext
): Promise<ShopifyAsset[]> {
  const res = await shopifyFetch<{ assets: ShopifyAsset[] }>(
    `/themes/${themeId}/assets.json`,
    withCtx({}, ctx)
  );
  return res.assets;
}

export async function assetGet(
  themeId: number,
  key: string,
  ctx?: ShopContext
): Promise<ShopifyAsset> {
  const res = await shopifyFetch<{ asset: ShopifyAsset }>(
    `/themes/${themeId}/assets.json`,
    withCtx({ query: { "asset[key]": key } }, ctx)
  );
  return res.asset;
}

export async function assetUpsert(
  themeId: number,
  key: string,
  value: string,
  retry?: ShopifyFetchOptions["retry"],
  ctx?: ShopContext
): Promise<ShopifyAsset> {
  const res = await shopifyFetch<{ asset: ShopifyAsset }>(
    `/themes/${themeId}/assets.json`,
    withCtx(
      { method: "PUT", body: { asset: { key, value } }, ...(retry ? { retry } : {}) },
      ctx
    )
  );
  return res.asset;
}

/**
 * PUT a raw asset body — text (`value`) or binary (`attachment`, base64).
 * Used by themes.ts#themeDuplicate to copy binary assets (images, fonts)
 * that assetUpsert's text-only signature can't carry.
 */
export async function assetPut(
  themeId: number,
  asset: { key: string; value?: string; attachment?: string },
  ctx?: ShopContext
): Promise<ShopifyAsset> {
  const res = await shopifyFetch<{ asset: ShopifyAsset }>(
    `/themes/${themeId}/assets.json`,
    withCtx({ method: "PUT", body: { asset } }, ctx)
  );
  return res.asset;
}

export async function assetDelete(
  themeId: number,
  key: string,
  ctx?: ShopContext
): Promise<void> {
  await shopifyFetch(
    `/themes/${themeId}/assets.json`,
    withCtx({ method: "DELETE", query: { "asset[key]": key } }, ctx)
  );
}

/** Publish a theme (set role to "main" / live). Atomic swap on Shopify's side. */
export async function themePublish(
  themeId: number,
  ctx?: ShopContext
): Promise<ShopifyTheme> {
  const res = await shopifyFetch<{ theme: ShopifyTheme }>(
    `/themes/${themeId}.json`,
    withCtx({ method: "PUT", body: { theme: { id: themeId, role: "main" } } }, ctx)
  );
  return res.theme;
}
