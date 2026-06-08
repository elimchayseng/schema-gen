/**
 * Apply orchestration (plan §7 items 1–3, Phase 3). Takes the gate-passing entries a
 * run staged and commits them to the theme SAFELY:
 *
 *   applyEntries(items)
 *     1. BACKUP   capture theme.liquid + snippet exactly as they are now (snapshot).
 *     2. WRITE    render the snippet from ALL entries, write it, add the idempotent
 *                 include to theme.liquid (the SchemaGen footprint).
 *     3. L4       for each item, verify the LIVE render carries valid schema (verify.ts).
 *     4a. all pass ─▶ APPLIED. The footprint stays.
 *     4b. any fail ─▶ ATOMIC ROLLBACK: restore theme.liquid byte-identical and restore
 *                     OR DELETE the snippet (delete iff it didn't exist pre-run), so the
 *                     theme returns to its exact prior state. status=rolled_back.
 *     4c. rollback throws ─▶ status=paged. Theme is dirty; the caller halts and pages.
 *
 * D1: strategy is "in-place on the live theme". The ThemeAssetOps seam is where a future
 * staging-theme strategy (duplicate → write copy → verify preview → publish) slots in
 * without touching the backup/verify/rollback control flow below.
 * D2: rollback is whole-footprint atomic — no per-entry pruning.
 *
 * All Shopify I/O is injected (ThemeAssetOps), so unit tests drive an in-memory theme and
 * never touch the network. `makeShopifyOps()` wires the real Asset API for production.
 */
import {
  renderSchemaGenSnippet,
  type SnippetEntry,
} from "@/lib/shopify/snippet";
import { upsertMarkerBlock } from "@/lib/shopify/theme-liquid";
import { assetDelete, assetGet, assetUpsert } from "@/lib/shopify/assets";
import { ShopifyError } from "@/lib/shopify/client";
import { LAYOUT_ASSET_KEY, SNIPPET_ASSET_KEY } from "@/lib/shopify/install";
import type { ActionRecord, ApplyResult, GateResult } from "./types";

/** The minimal theme-asset surface apply needs. `get` returns null for an absent asset. */
export interface ThemeAssetOps {
  get(themeId: number, key: string): Promise<string | null>;
  put(themeId: number, key: string, value: string): Promise<void>;
  del(themeId: number, key: string): Promise<void>;
}

/** One staged page: the storefront URL to verify + its validated snippet entry. */
export interface ApplyItem {
  url: string;
  entry: SnippetEntry;
}

export interface ApplyParams {
  /** agent_runs id; threaded into backup rows and audit. */
  runId: string | null;
  /** The live theme to write to (in-place strategy). */
  themeId: number;
  shop: string;
  items: ApplyItem[];
  ops: ThemeAssetOps;
  /** L4 live verify for one item. Returns a GateResult (never throws). */
  verify: (url: string, entry: SnippetEntry) => Promise<GateResult>;
  /** Best-effort snapshot persistence (theme_backups). Failures never abort the apply. */
  persistBackup?: (assetKey: string, valueBefore: string | null) => Promise<void>;
}

function action(
  url: string,
  kind: ActionRecord["action"],
  outcome: string,
  extra: Partial<ActionRecord> = {}
): ActionRecord {
  return {
    url,
    action: kind,
    schemaBefore: null,
    schemaAfter: null,
    gates: null,
    outcome,
    writeTarget: extra.writeTarget ?? null,
    ...extra,
  };
}

/**
 * Restore the footprint to its pre-run state, byte-identical.
 * Order mirrors uninstall: theme.liquid first (drops the include) THEN the snippet, so
 * there is never a window where the layout includes a missing snippet.
 * A snippet that did NOT exist pre-run is DELETED (not restored to ""), so "byte-identical"
 * means the asset is genuinely gone, exactly as before.
 */
async function restoreFootprint(
  ops: ThemeAssetOps,
  themeId: number,
  layoutBefore: string,
  snippetBefore: string | null
): Promise<void> {
  await ops.put(themeId, LAYOUT_ASSET_KEY, layoutBefore);
  if (snippetBefore === null) {
    await ops.del(themeId, SNIPPET_ASSET_KEY);
  } else {
    await ops.put(themeId, SNIPPET_ASSET_KEY, snippetBefore);
  }
}

export async function applyEntries(params: ApplyParams): Promise<ApplyResult> {
  const { runId: _runId, themeId, items, ops, verify, persistBackup } = params;
  void _runId; // threaded for symmetry / future per-run backup keying
  const writeTarget = String(themeId);
  const actions: ActionRecord[] = [];

  // Nothing staged → nothing to apply. Caller treats this as a no-op success.
  if (items.length === 0) {
    return { status: "applied", writeTarget: null, l4: [], actions };
  }

  // 1. BACKUP — snapshot both assets BEFORE the first write.
  const layoutBefore = await ops.get(themeId, LAYOUT_ASSET_KEY);
  if (layoutBefore === null) {
    // theme.liquid always exists on a real theme; its absence means a bad themeId.
    throw new Error(
      `Cannot apply: ${LAYOUT_ASSET_KEY} not found on theme ${themeId}`
    );
  }
  const snippetBefore = await ops.get(themeId, SNIPPET_ASSET_KEY); // null = absent pre-run
  if (persistBackup) {
    // Best-effort: a failed backup-row write must not block the apply (the in-memory
    // before-values above are the operative rollback token either way).
    await persistBackup(LAYOUT_ASSET_KEY, layoutBefore).catch(() => {});
    await persistBackup(SNIPPET_ASSET_KEY, snippetBefore).catch(() => {});
  }

  // 2+3. WRITE the footprint (snippet from ALL entries + idempotent include) then L4
  // verify each item's live render. Both a thrown write/verify error (network/500,
  // missing </head> anchor) AND an L4 gate failure converge on the SAME rollback below,
  // so "backup before touch → restore on any failure" holds for write errors too — not
  // only gate failures. Atomic: stop at the first failure (the rest roll back anyway).
  const snippet = renderSchemaGenSnippet(items.map((i) => i.entry));
  const l4: (GateResult | null)[] = [];
  let failure: { url: string; reason: string } | null = null;

  try {
    await ops.put(themeId, SNIPPET_ASSET_KEY, snippet);
    const layoutAfter = upsertMarkerBlock(layoutBefore);
    if (layoutAfter !== layoutBefore) {
      await ops.put(themeId, LAYOUT_ASSET_KEY, layoutAfter);
    }
    actions.push(
      action(items[0].url, "write", "footprint_written", { writeTarget })
    );

    for (const item of items) {
      const result = await verify(item.url, item.entry);
      l4.push(result);
      actions.push(
        action(item.url, "verify", result.passed ? "l4_pass" : "l4_fail", {
          gates: { L0: { passed: true }, L1: { passed: true }, L2: null, L3: { passed: true }, L4: result },
          writeTarget,
        })
      );
      if (!result.passed) {
        failure = { url: item.url, reason: result.detail ?? "L4 failed" };
        break;
      }
    }
  } catch (writeErr) {
    const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    failure = { url: items[0].url, reason: `write error: ${msg}` };
  }

  if (!failure) {
    return { status: "applied", writeTarget, l4, actions };
  }

  // 4. ROLLBACK — atomic restore to byte-identical pre-run state.
  try {
    await restoreFootprint(ops, themeId, layoutBefore, snippetBefore);
  } catch (rollbackErr) {
    const msg =
      rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
    actions.push(
      action(failure.url, "rollback", `rollback_failed: ${msg}`, { writeTarget })
    );
    return { status: "paged", writeTarget, l4, actions, error: msg };
  }
  actions.push(
    action(failure.url, "rollback", `rolled_back: ${failure.reason}`, {
      writeTarget,
    })
  );
  return { status: "rolled_back", writeTarget, l4, actions };
}

/**
 * Production ThemeAssetOps over the real Asset API. A 404 on GET becomes null (absent
 * asset), which is the signal restoreFootprint uses to delete-on-rollback.
 */
export function makeShopifyOps(): ThemeAssetOps {
  return {
    async get(themeId, key) {
      try {
        return (await assetGet(themeId, key)).value ?? null;
      } catch (e) {
        if (e instanceof ShopifyError && e.status === 404) return null;
        throw e;
      }
    },
    async put(themeId, key, value) {
      await assetUpsert(themeId, key, value);
    },
    async del(themeId, key) {
      // Deleting an already-absent asset is success (the post-condition "asset gone"
      // holds). This matters on rollback when the snippet write itself failed: restore
      // tries to delete a snippet that may never have landed. A 404 must not turn a
      // clean rollback into a false "paged".
      try {
        await assetDelete(themeId, key);
      } catch (e) {
        if (e instanceof ShopifyError && e.status === 404) return;
        throw e;
      }
    },
  };
}
