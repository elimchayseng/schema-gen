/**
 * Install / uninstall the SchemaGen footprint on a theme (agent Phase 1).
 *
 * Footprint = one managed snippet + one delimited include line in theme.liquid.
 *
 *   install:   write snippet ──▶ ensure include present (backup + rollback)
 *   uninstall: remove include (backup + rollback) ──▶ delete snippet
 *
 * Ordering is deliberate: on install the snippet exists before anything renders
 * it; on uninstall the include is gone before the snippet is deleted, so there's
 * never a window where theme.liquid renders a missing snippet.
 *
 * Backup policy differs per asset, on purpose:
 *  - theme.liquid is shared, hand-editable merchant code, so its write goes
 *    through safeAssetUpsert (snapshot + auto-rollback on failure).
 *  - the snippet is wholly SchemaGen-owned and may not exist yet, so it uses a
 *    plain idempotent assetUpsert. Routing it through safeAssetUpsert would 404
 *    on first install (backupAsset GETs a not-yet-existing asset). A failed
 *    snippet write throws before the include is added, leaving no dirty state;
 *    an orphan snippet with no include simply renders nothing.
 *
 * Live re-fetch / rendered-output verification (L4) is added in Phase 3.
 */
import { assetDelete, assetGet, assetUpsert } from "./assets";
import { safeAssetUpsert } from "./backup";
import { renderSchemaGenSnippet, type SnippetEntry } from "./snippet";
import { removeMarkerBlock, SNIPPET_NAME, upsertMarkerBlock } from "./theme-liquid";

export const SNIPPET_ASSET_KEY = `snippets/${SNIPPET_NAME}.liquid`;
export const LAYOUT_ASSET_KEY = "layout/theme.liquid";

export interface InstallContext {
  themeId: number;
  shop: string;
  /** agent_runs id when called from a run; null/omitted for standalone use. */
  runId?: string | null;
}

/** Returns true if the theme.liquid include was changed (false if already current). */
async function reconcileLayout(
  ctx: InstallContext,
  transform: (current: string) => string
): Promise<boolean> {
  const layout = await assetGet(ctx.themeId, LAYOUT_ASSET_KEY);
  const before = layout.value ?? "";
  const after = transform(before);
  if (after === before) return false;
  await safeAssetUpsert(
    {
      runId: ctx.runId,
      shop: ctx.shop,
      themeId: ctx.themeId,
      assetKey: LAYOUT_ASSET_KEY,
    },
    after
  );
  return true;
}

/**
 * Write the rendered snippet and ensure theme.liquid includes it. Idempotent:
 * re-running with the same entries produces no net change.
 */
export async function installSchemaGen(
  ctx: InstallContext,
  entries: SnippetEntry[]
): Promise<void> {
  const snippet = renderSchemaGenSnippet(entries);
  await assetUpsert(ctx.themeId, SNIPPET_ASSET_KEY, snippet);
  await reconcileLayout(ctx, upsertMarkerBlock);
}

/** Remove the include from theme.liquid, then delete the managed snippet. */
export async function uninstallSchemaGen(ctx: InstallContext): Promise<void> {
  await reconcileLayout(ctx, removeMarkerBlock);
  await assetDelete(ctx.themeId, SNIPPET_ASSET_KEY);
}
