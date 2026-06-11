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
  mergeSnippetEntries,
  parseSchemaGenSnippet,
  renderSchemaGenSnippet,
  type SnippetEntry,
} from "@/lib/shopify/snippet";
import { upsertMarkerBlock } from "@/lib/shopify/theme-liquid";
import { assetDelete, assetGet, assetUpsert } from "@/lib/shopify/assets";
import { ShopifyError } from "@/lib/shopify/client";
import { LAYOUT_ASSET_KEY, SNIPPET_ASSET_KEY } from "@/lib/shopify/install";
import {
  suppressJsonLdEmission,
  type SuppressMatch,
} from "@/lib/shopify/suppress";
import type { ShopContext } from "@/lib/shopify/types";
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

/**
 * One competing theme JSON-LD emission to reversibly silence (issue #23).
 * The ORCHESTRATOR computes the plan (which asset, which script element);
 * apply only executes it inside its backup → write → verify → rollback envelope.
 */
export interface ApplySuppression {
  /** Theme asset whose JSON-LD emission must be silenced, e.g. "sections/main-product.liquid". */
  assetKey: string;
  /** Which script element(s) within the asset (see suppressJsonLdEmission). */
  match: SuppressMatch;
  /** The page whose duplicate this suppression resolves — for the audit row. */
  url?: string;
}

/**
 * Per-item context handed to the injected L4 verify. `unique:true` (set whenever the
 * apply carries suppressions) asks the verifier to run the duplicate-prevention gate
 * (issue #24) — l4Verify's L4VerifyInput.unique. The param is OPTIONAL and additive:
 * today's run.ts makeLiveVerify `(url, _entry) => …` ignores it and behaves exactly as
 * before. NEXT AGENT (run.ts): forward `ctx?.unique` into l4Verify({ …, unique }) so
 * authoritative applies actually enforce exactly-one-block-per-type live.
 */
export interface VerifyContext {
  unique: boolean;
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
  verify: (
    url: string,
    entry: SnippetEntry,
    ctx?: VerifyContext
  ) => Promise<GateResult>;
  /** Best-effort snapshot persistence (theme_backups). Failures never abort the apply. */
  persistBackup?: (assetKey: string, valueBefore: string | null) => Promise<void>;
  /**
   * Competing-emission suppressions to execute as part of this apply's footprint
   * (issue #23, authoritative mode). Each target asset is backed up BEFORE any write
   * and restored byte-identical by the same atomic rollback that covers
   * theme.liquid/snippet. A target that cannot be safely suppressed records a
   * `merchant_action` row and the apply CONTINUES (not fatal). Omitted/empty keeps
   * the legacy non-authoritative behavior byte-identical.
   */
  suppressions?: ApplySuppression[];
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
  snippetBefore: string | null,
  /** assetKey → ORIGINAL bytes, for every suppression target whose write was attempted. */
  suppressedBefore: Map<string, string> = new Map()
): Promise<void> {
  await ops.put(themeId, LAYOUT_ASSET_KEY, layoutBefore);
  if (snippetBefore === null) {
    await ops.del(themeId, SNIPPET_ASSET_KEY);
  } else {
    await ops.put(themeId, SNIPPET_ASSET_KEY, snippetBefore);
  }
  // Suppressed assets (issue #23) are part of the same atomic footprint: restore each
  // to its exact pre-run bytes (the backup map is the rollback token, same as above).
  for (const [assetKey, before] of suppressedBefore) {
    await ops.put(themeId, assetKey, before);
  }
}

export async function applyEntries(params: ApplyParams): Promise<ApplyResult> {
  const { runId: _runId, themeId, items, ops, verify, persistBackup } = params;
  void _runId; // threaded for symmetry / future per-run backup keying
  const writeTarget = String(themeId);
  const actions: ActionRecord[] = [];
  const suppressions = params.suppressions ?? [];
  // Suppressions requested → the post-write verify must run the duplicate-prevention
  // gate (issue #24): exactly one valid block per required type on the live render.
  const unique = suppressions.length > 0;

  // Nothing staged → nothing to apply. Caller treats this as a no-op success.
  if (items.length === 0) {
    return { status: "applied", writeTarget: null, l4: [], actions };
  }

  // 1. BACKUP — snapshot both footprint assets AND every suppression target BEFORE
  // the first write (one backup map; all of it is the rollback token).
  const layoutBefore = await ops.get(themeId, LAYOUT_ASSET_KEY);
  if (layoutBefore === null) {
    // theme.liquid always exists on a real theme; its absence means a bad themeId.
    throw new Error(
      `Cannot apply: ${LAYOUT_ASSET_KEY} not found on theme ${themeId}`
    );
  }
  const snippetBefore = await ops.get(themeId, SNIPPET_ASSET_KEY); // null = absent pre-run
  const suppressionBackups = new Map<string, string | null>();
  for (const s of suppressions) {
    if (!suppressionBackups.has(s.assetKey)) {
      suppressionBackups.set(s.assetKey, await ops.get(themeId, s.assetKey));
    }
  }
  if (persistBackup) {
    // Best-effort: a failed backup-row write must not block the apply (the in-memory
    // before-values above are the operative rollback token either way).
    await persistBackup(LAYOUT_ASSET_KEY, layoutBefore).catch(() => {});
    await persistBackup(SNIPPET_ASSET_KEY, snippetBefore).catch(() => {});
    for (const [assetKey, before] of suppressionBackups) {
      await persistBackup(assetKey, before).catch(() => {});
    }
  }

  // 2+3. WRITE the footprint (snippet from ALL entries + idempotent include) then L4
  // verify each item's live render. Both a thrown write/verify error (network/500,
  // missing </head> anchor) AND an L4 gate failure converge on the SAME rollback below,
  // so "backup before touch → restore on any failure" holds for write errors too — not
  // only gate failures. Atomic: stop at the first failure (the rest roll back anyway).
  //
  // MERGE, never replace: the pre-run snippet (already in hand as the backup) carries
  // the entries earlier runs wrote for OTHER pages. A run scoped to a subset of pages
  // must not delete the rest of the store's schema — observed live: a 2-URL run wiped
  // the third product's JSON-LD while the theme emitters stayed suppressed.
  const snippet = renderSchemaGenSnippet(
    mergeSnippetEntries(
      snippetBefore ? parseSchemaGenSnippet(snippetBefore) : [],
      items.map((i) => i.entry)
    )
  );
  const l4: (GateResult | null)[] = [];
  let failure: { url: string; reason: string } | null = null;
  // assetKey → ORIGINAL bytes for every suppression target whose write was ATTEMPTED
  // (recorded BEFORE the put, so a put that throws mid-flight is still restored).
  const suppressedBefore = new Map<string, string>();
  const suppressedAssets: string[] = [];

  try {
    await ops.put(themeId, SNIPPET_ASSET_KEY, snippet);
    const layoutAfter = upsertMarkerBlock(layoutBefore);
    if (layoutAfter !== layoutBefore) {
      await ops.put(themeId, LAYOUT_ASSET_KEY, layoutAfter);
    }
    actions.push(
      action(items[0].url, "write", "footprint_written", { writeTarget })
    );

    // 2b. SUPPRESS (issue #23) — silence each competing theme emission. Pure text
    // transform over the BACKED-UP value (no re-fetch; the backup is the source of
    // truth this run). Not-suppressible targets become merchant_action rows and the
    // apply CONTINUES — only a thrown write error or an L4 failure rolls back.
    const workingText = new Map<string, string>(); // latest text per asset this run
    for (const s of suppressions) {
      const before = suppressionBackups.get(s.assetKey) ?? null;
      if (before === null) {
        actions.push(
          action(
            s.url ?? "",
            "merchant_action",
            `not_suppressible:${s.assetKey}:asset not found on theme`,
            { writeTarget }
          )
        );
        continue;
      }
      // Two suppressions on the same asset chain: the second operates on the
      // first's output, while the restore token stays the ORIGINAL bytes.
      const base = workingText.get(s.assetKey) ?? before;
      const res = suppressJsonLdEmission(base, { match: s.match });
      if (!res.ok) {
        actions.push(
          action(
            s.url ?? "",
            "merchant_action",
            `not_suppressible:${s.assetKey}:${res.reason}`,
            { writeTarget }
          )
        );
        continue;
      }
      if (!res.changed) continue; // already suppressed (idempotent re-run) — no write
      suppressedBefore.set(s.assetKey, before);
      await ops.put(themeId, s.assetKey, res.text);
      workingText.set(s.assetKey, res.text);
      if (!suppressedAssets.includes(s.assetKey)) {
        suppressedAssets.push(s.assetKey);
      }
      actions.push(
        action(s.url ?? "", "suppress", `suppressed:${s.assetKey}`, {
          writeTarget,
        })
      );
    }

    for (const item of items) {
      const result = await verify(item.url, item.entry, { unique });
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
    return suppressions.length > 0
      ? { status: "applied", writeTarget, l4, actions, suppressedAssets }
      : { status: "applied", writeTarget, l4, actions };
  }

  // 4. ROLLBACK — atomic restore to byte-identical pre-run state. The footprint AND
  // every suppressed asset come back from the same backup map.
  try {
    await restoreFootprint(
      ops,
      themeId,
      layoutBefore,
      snippetBefore,
      suppressedBefore
    );
  } catch (rollbackErr) {
    const msg =
      rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
    actions.push(
      action(failure.url, "rollback", `rollback_failed: ${msg}`, { writeTarget })
    );
    return { status: "paged", writeTarget, l4, actions, error: msg };
  }
  // Name every restored suppressed asset in the audit (issue #23 requirement).
  for (const assetKey of suppressedBefore.keys()) {
    actions.push(
      action(failure.url, "rollback", `restored_suppressed:${assetKey}`, {
        writeTarget,
      })
    );
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
 * `ctx` (issue #25) targets a specific shop + credentials; omitted = the
 * env-configured shop, byte-identical to the pre-#25 behavior.
 */
export function makeShopifyOps(ctx?: ShopContext): ThemeAssetOps {
  return {
    async get(themeId, key) {
      try {
        return (await assetGet(themeId, key, ctx)).value ?? null;
      } catch (e) {
        if (e instanceof ShopifyError && e.status === 404) return null;
        throw e;
      }
    },
    async put(themeId, key, value) {
      await assetUpsert(themeId, key, value, undefined, ctx);
    },
    async del(themeId, key) {
      // Deleting an already-absent asset is success (the post-condition "asset gone"
      // holds). This matters on rollback when the snippet write itself failed: restore
      // tries to delete a snippet that may never have landed. A 404 must not turn a
      // clean rollback into a false "paged".
      try {
        await assetDelete(themeId, key, ctx);
      } catch (e) {
        if (e instanceof ShopifyError && e.status === 404) return;
        throw e;
      }
    },
  };
}
