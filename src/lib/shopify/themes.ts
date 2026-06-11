/**
 * Live-theme safety plumbing (issue #26).
 *
 * garnerandtow.com is LIVE PRODUCTION. The agent must never write to the
 * published ("main") theme directly. The safe flow this module enables:
 *
 *   themesList() ──▶ prepareStagingTheme() ─┬─▶ duplicate live theme (asset copy)
 *                                            └─▶ { stagingThemeId, previewUrl }
 *   ... agent writes to the staging theme (assertSafeWriteTheme guards it) ...
 *   ... merchant reviews previewUrl ...
 *   themePublish(stagingThemeId) ──▶ atomic swap to live
 *
 * Shopify has no "duplicate theme" Admin API call (REST or GraphQL as of
 * 2025-01), so themeDuplicate() does it the established way: create a fresh
 * unpublished theme, then copy every asset of the source theme into it
 * (text via `value`, binary via base64 `attachment`). On a partial-copy
 * failure the half-built theme is deleted so no broken staging theme lingers.
 *
 * Every function takes an optional trailing ShopContext (issue #25); without
 * it, calls target the env-configured shop.
 */
import {
  assetGet,
  assetPut,
  assetsList,
  listThemes,
  themeCreate,
  themeDelete,
} from "./assets";
import { getShopifyConfig, normalizeShop } from "./config";
import { shopifyLog } from "./logger";
import type { ShopContext, ShopifyTheme } from "./types";

export { themePublish, themeDelete } from "./assets";

/** List all themes on the shop (role "main" is the published/live one). */
export async function themesList(ctx?: ShopContext): Promise<ShopifyTheme[]> {
  return listThemes(ctx);
}

export interface SafeWriteOptions {
  /**
   * Explicit opt-in to write to the published ("main") theme. Default false:
   * a published-theme write throws. (Open item from E2E_BRINGUP_REPORT.md.)
   */
  allowPublishedWrite?: boolean;
}

/**
 * Published-theme write guard. Validates that `themeId` is a known,
 * non-published theme before any asset write targets it. Returns the matched
 * theme so callers can keep its name/role for logging.
 *
 * Throws when:
 *  - the theme id is not on this shop at all (typo'd / stale env id), or
 *  - the theme is published (role "main") and allowPublishedWrite wasn't set.
 */
export function assertSafeWriteTheme(
  themeId: number,
  themes: ShopifyTheme[],
  opts: SafeWriteOptions = {}
): ShopifyTheme {
  const theme = themes.find((t) => t.id === themeId);
  if (!theme) {
    throw new Error(
      `Refusing to write: theme ${themeId} not found on this shop ` +
        `(known ids: ${themes.map((t) => t.id).join(", ") || "none"})`
    );
  }
  if (theme.role === "main" && !opts.allowPublishedWrite) {
    throw new Error(
      `Refusing to write to published theme ${themeId} ("${theme.name}", role "main"). ` +
        `Use prepareStagingTheme() to duplicate it and write to the copy, ` +
        `or pass allowPublishedWrite: true to override explicitly.`
    );
  }
  return theme;
}

/**
 * Resolve and guard a write-target theme id in one step: fetches the theme
 * list, then applies assertSafeWriteTheme. Convenience for the orchestrator.
 */
export async function resolveWriteThemeId(
  themeId: number,
  opts: SafeWriteOptions = {},
  ctx?: ShopContext
): Promise<ShopifyTheme> {
  const themes = await themesList(ctx);
  return assertSafeWriteTheme(themeId, themes, opts);
}

/**
 * True duplicate of an existing theme: create a fresh unpublished theme named
 * `name`, then copy every asset from theme `themeId` into it. Cleans up the
 * new theme if the copy fails partway.
 *
 * Note: asset-by-asset copy is O(assets) Admin API calls and rate-limited by
 * shopifyFetch's backoff — expect minutes, not seconds, on a real theme.
 */
/**
 * Copy order matters: Shopify VALIDATES on PUT, and a template/section-group
 * that names a section type 422s unless that section file already exists on the
 * target. Copy the referenced kinds first, the referencing kinds last.
 */
const ASSET_COPY_ORDER = [
  "assets/",
  "locales/",
  "blocks/",
  "snippets/",
  "sections/",
  "layout/",
  "config/",
  "templates/",
];
function assetCopyRank(key: string): number {
  const i = ASSET_COPY_ORDER.findIndex((p) => key.startsWith(p));
  return i === -1 ? ASSET_COPY_ORDER.length : i;
}

export async function themeDuplicate(
  themeId: number,
  name: string,
  ctx?: ShopContext
): Promise<ShopifyTheme> {
  const sourceAssets = [...(await assetsList(themeId, ctx))].sort(
    (a, b) => assetCopyRank(a.key) - assetCopyRank(b.key)
  );
  const target = await themeCreate(name, undefined, ctx);
  shopifyLog("info", "Duplicating theme", {
    sourceThemeId: themeId,
    targetThemeId: target.id,
    assetCount: sourceAssets.length,
  });
  try {
    const putOne = async (key: string): Promise<void> => {
      const full = await assetGet(themeId, key, ctx);
      if (full.attachment != null) {
        await assetPut(target.id, { key, attachment: full.attachment }, ctx);
      } else if (full.value != null) {
        await assetPut(target.id, { key, value: full.value }, ctx);
      }
      // Assets with neither value nor attachment (shouldn't happen) are skipped.
    };

    // First pass in dependency-safe order; 422s (cross-asset references Shopify
    // can't resolve yet) are deferred, anything else is fatal.
    let deferred: string[] = [];
    for (const meta of sourceAssets) {
      try {
        await putOne(meta.key);
      } catch (e) {
        if ((e as { status?: number }).status === 422) {
          deferred.push(meta.key);
        } else {
          throw e;
        }
      }
    }
    // Retry deferred assets until a full pass makes no progress — each pass can
    // only succeed where its dependencies landed in an earlier one.
    while (deferred.length > 0) {
      const stillFailing: string[] = [];
      let lastErr: unknown = null;
      for (const key of deferred) {
        try {
          await putOne(key);
        } catch (e) {
          if ((e as { status?: number }).status === 422) {
            stillFailing.push(key);
            lastErr = e;
          } else {
            throw e;
          }
        }
      }
      if (stillFailing.length === deferred.length) {
        // No progress — the references are genuinely unsatisfiable.
        throw lastErr instanceof Error
          ? lastErr
          : new Error(`theme duplicate: ${stillFailing.length} assets failed validation`);
      }
      shopifyLog("info", "Theme duplicate retry pass", {
        targetThemeId: target.id,
        resolved: deferred.length - stillFailing.length,
        remaining: stillFailing.length,
      });
      deferred = stillFailing;
    }
  } catch (err) {
    // Never leave a half-copied staging theme behind — it looks usable but isn't.
    try {
      await themeDelete(target.id, ctx);
    } catch (cleanupErr) {
      shopifyLog("warn", "Failed to clean up partial theme duplicate", {
        targetThemeId: target.id,
        error:
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    throw err;
  }
  return target;
}

export interface StagingTheme {
  stagingThemeId: number;
  /** Merchant-reviewable URL: live storefront rendered with the staging theme. */
  previewUrl: string;
  /** The theme that was duplicated (the published theme unless overridden). */
  sourceThemeId: number;
}

/**
 * Prepare a staging copy for the safe-edit flow: duplicate the published theme
 * (or an explicit `liveThemeId`) and return the staging id plus the
 * `?preview_theme_id=` URL the merchant reviews before themePublish() swaps it
 * live. The agent then writes ONLY to stagingThemeId.
 */
export async function prepareStagingTheme(
  liveThemeId: number | undefined,
  name: string,
  ctx?: ShopContext
): Promise<StagingTheme> {
  const themes = await themesList(ctx);
  const source =
    liveThemeId != null
      ? themes.find((t) => t.id === liveThemeId)
      : themes.find((t) => t.role === "main");
  if (!source) {
    throw new Error(
      liveThemeId != null
        ? `Cannot stage: theme ${liveThemeId} not found on this shop`
        : "Cannot stage: no published (role \"main\") theme found on this shop"
    );
  }

  const staging = await themeDuplicate(source.id, name, ctx);
  const shop = ctx ? normalizeShop(ctx.shop) : getShopifyConfig().shop;
  return {
    stagingThemeId: staging.id,
    previewUrl: `https://${shop}/?preview_theme_id=${staging.id}`,
    sourceThemeId: source.id,
  };
}
