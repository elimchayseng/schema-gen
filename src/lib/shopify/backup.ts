/**
 * Backup + restore for Shopify theme assets (agent Phase 0).
 *
 * The rollback token: before any write we snapshot the current asset value into
 * `theme_backups`. Restore re-PUTs that exact value, so a restore is
 * byte-identical to the pre-write state.
 *
 *   safeAssetUpsert():
 *     backupAsset() ──▶ assetUpsert() ──┬── ok ──▶ return
 *                                        └── throws ──▶ restoreAsset() ──▶ rethrow
 *
 * Writes go through the service-role admin client (RLS-bypassing, server-only).
 *
 * Phase 0 boundary: restore = upsert(value_before). theme.liquid always exists,
 * so value_before is the real prior content. Restoring a NEWLY-created asset
 * (one absent before the write) to "" leaves an empty file rather than deleting
 * it — clean delete-on-restore for managed snippets arrives with Phase 1/3.
 */
import { createAdminClient } from "@/lib/supabase";
import { assetGet, assetUpsert } from "./assets";
import { ShopifyError } from "./client";
import { shopifyLog } from "./logger";
import type { ShopifyAsset, ThemeBackup } from "./types";

/**
 * Restore retries are deliberately tight. By the time a restore runs, the write
 * has already exhausted the default budget against a degraded Shopify, so the
 * restore fails fast (a few seconds) instead of hanging for minutes.
 */
const RESTORE_RETRY = { maxRetries: 2 } as const;

/** Error thrown when a write fails AND its rollback also fails. */
export interface RollbackFailedError extends ShopifyError {
  rollbackFailed: true;
  cause?: unknown;
}

export interface BackupParams {
  /** agent_runs id when called from a run; null for standalone Phase 0 backups. */
  runId?: string | null;
  shop: string;
  themeId: number;
  assetKey: string;
}

/** Snapshot the current value of an asset into theme_backups. */
export async function backupAsset(params: BackupParams): Promise<ThemeBackup> {
  const { runId = null, shop, themeId, assetKey } = params;
  const current = await assetGet(themeId, assetKey);
  const valueBefore = current.value ?? "";

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("theme_backups")
    .insert({
      run_id: runId,
      shop,
      theme_id: themeId,
      asset_key: assetKey,
      asset_value_before: valueBefore,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to write theme_backups: ${error.message}`);
  }
  return data as ThemeBackup;
}

/** Restore an asset to the exact value captured in a backup row. */
export async function restoreAsset(backup: ThemeBackup): Promise<ShopifyAsset> {
  return assetUpsert(
    backup.theme_id,
    backup.asset_key,
    backup.asset_value_before,
    RESTORE_RETRY
  );
}

/**
 * Upsert an asset with automatic rollback: snapshot first, write, and on any
 * write failure restore the snapshot before rethrowing. This is the safe-write
 * primitive Phase 3's auto-rollback guardrail builds on.
 *
 * Error contract:
 *  - write fails, restore succeeds → rethrows the original write error.
 *  - write fails AND restore fails → throws a RollbackFailedError (the theme is
 *    left dirty) that preserves the original write error as `.cause`. The
 *    restore error never silently replaces the write error.
 */
export async function safeAssetUpsert(
  params: BackupParams,
  value: string
): Promise<ShopifyAsset> {
  const backup = await backupAsset(params);
  try {
    return await assetUpsert(params.themeId, params.assetKey, value);
  } catch (writeErr) {
    shopifyLog("error", "Asset write failed, restoring from backup", {
      themeId: params.themeId,
      assetKey: params.assetKey,
      backupId: backup.id,
      error: writeErr instanceof Error ? writeErr.message : String(writeErr),
    });
    try {
      await restoreAsset(backup);
    } catch (restoreErr) {
      const writeMsg =
        writeErr instanceof Error ? writeErr.message : String(writeErr);
      const restoreMsg =
        restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      shopifyLog("error", "ROLLBACK FAILED — theme left dirty", {
        themeId: params.themeId,
        assetKey: params.assetKey,
        backupId: backup.id,
        restoreError: restoreMsg,
      });
      const dirty = new ShopifyError(
        `Asset write failed AND rollback failed (theme ${params.themeId} ${params.assetKey} left dirty): ${writeMsg}; restore: ${restoreMsg}`,
        0
      ) as RollbackFailedError;
      dirty.rollbackFailed = true;
      dirty.cause = writeErr;
      throw dirty;
    }
    throw writeErr;
  }
}
