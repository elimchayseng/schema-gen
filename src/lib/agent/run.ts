/**
 * runGoal — the agent loop entry point (plan §3). Perceive → plan → act, in
 * dry-run. The LLM only runs inside the executor's processPage("optimize"); the
 * planner and every gate are deterministic. Nothing is written to Shopify in
 * Phase 2 — the staged snippet that *would* be written is returned for diffing.
 */
import { processPage } from "@/lib/crawl/process-page";
import { fetchSitemap } from "@/lib/crawl/sitemap";
import { fetchPage } from "@/lib/url-validator/fetcher";
import { createAdminClient } from "@/lib/supabase";
import { getRichResultInfo } from "@/lib/validation/rich-results";
import { renderSchemaGenSnippet, urlToTemplateTarget } from "@/lib/shopify/snippet";
import { getShopifyConfig } from "@/lib/shopify/config";
import type { SnippetEntry } from "@/lib/shopify/snippet";
import type { PageResult } from "@/lib/crawl/types";
import { planTasks } from "./planner";
import { executeTask } from "./executor";
import { hasCriticalIssue } from "./gates";
import { l4Verify } from "./verify";
import { applyEntries, makeShopifyOps, type ApplyItem } from "./apply";
import {
  makeBreakers,
  recordOutcome,
  recordRollbackFailure,
  tripped,
} from "./breakers";
import { createRun, finishRun, recordAction } from "./audit";

function warn(msg: string, e: unknown): void {
  console.warn(`[agent] ${msg}: ${e instanceof Error ? e.message : String(e)}`);
}
import type {
  ActionRecord,
  ApplyResult,
  BreakerReason,
  Goal,
  GoalTarget,
  PerceivedPage,
  RunOptions,
  RunResult,
} from "./types";

/** Build a perceived-state record from a no-LLM scan of one page. */
function toPerceived(goal: Goal, url: string, scan: PageResult): PerceivedPage {
  const hadSchema = (scan.originalSchemas?.length ?? 0) > 0;
  const errorCount = scan.validationResults?.errorCount ?? 0;

  const validSchemas = (scan.validationResults?.schemas ?? []).filter(
    (s) => s.validation.valid
  );
  const validTypes = new Set(validSchemas.map((s) => s.type));
  const typesOk = goal.target.requireTypes.every((t) => validTypes.has(t));

  // rich-results skip path must match the L2 gate exactly: the required type must
  // be rich-eligible AND every live valid schema of that type must be free of
  // critical-impact issues. Otherwise a page L2 would reject could be skipped.
  const richOk =
    goal.target.minOutcome !== "rich_results_eligible" ||
    goal.target.requireTypes.every((t) => {
      if (getRichResultInfo(t)?.eligible !== true) return false;
      const ofType = validSchemas.filter((s) => s.type === t);
      return (
        ofType.length > 0 && ofType.every((s) => !hasCriticalIssue(s.validation))
      );
    });

  return {
    url,
    status: scan.status,
    errorCount,
    hadSchema,
    satisfied: scan.status === "valid" && typesOk && richOk,
  };
}

/**
 * Best-effort snapshot row into theme_backups (the durable rollback record, keyed by
 * run). The in-memory pre-write value is the operative rollback token, so a failed
 * insert is logged and swallowed — it must never abort or corrupt the apply.
 */
async function backupRow(
  runId: string | null,
  shop: string,
  themeId: number,
  assetKey: string,
  valueBefore: string | null
): Promise<void> {
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from("theme_backups").insert({
      run_id: runId,
      shop,
      theme_id: themeId,
      asset_key: assetKey,
      asset_value_before: valueBefore ?? "",
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    warn("theme_backups insert failed (continuing)", e);
  }
}

async function getSiteDomain(siteId: string): Promise<string> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("sites")
    .select("domain")
    .eq("id", siteId)
    .single();
  if (error || !data) {
    throw new Error(`Could not resolve site domain for ${siteId}: ${error?.message}`);
  }
  return (data as { domain: string }).domain;
}

/** Resolve the goal's scope into a concrete URL list. */
async function resolveTargetUrls(goal: Goal): Promise<string[]> {
  if (goal.target.scope === "url_list") {
    return goal.target.urls ?? [];
  }
  const domain = await getSiteDomain(goal.siteId);
  const { urls } = await fetchSitemap(domain);
  const mapped = urls.map((u) => ({ url: u.loc, t: urlToTemplateTarget(u.loc) }));
  if (goal.target.scope === "all_products") {
    return mapped.filter((m) => m.t?.template === "product").map((m) => m.url);
  }
  // all_pages: any URL that maps to a known template.
  return mapped.filter((m) => m.t !== null).map((m) => m.url);
}

/**
 * Resolve the theme the live apply writes to. Per CLAUDE.md, the agent only ever
 * touches SHOPIFY_TEST_THEME_ID (or a duplicate) — never the published live theme.
 * Absent/invalid env is a hard error so a live run can't silently target the wrong theme.
 */
function resolveWriteThemeId(): number {
  const raw = process.env.SHOPIFY_TEST_THEME_ID;
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) {
    throw new Error(
      "Live apply requires a valid SHOPIFY_TEST_THEME_ID (never the published theme)"
    );
  }
  return id;
}

/**
 * L4 verify wired to the real page fetcher. The staged (unpublished) theme is rendered
 * via Shopify's `?preview_theme_id=` param, so verification reads the exact bytes the
 * write produced, not the currently-published theme.
 */
function makeLiveVerify(target: GoalTarget, themeId: number) {
  return (url: string, _entry: SnippetEntry) => {
    void _entry;
    const previewUrl = `${url}${url.includes("?") ? "&" : "?"}preview_theme_id=${themeId}`;
    return l4Verify({
      url: previewUrl,
      requireTypes: target.requireTypes,
      minOutcome: target.minOutcome,
      fetchHtml: async (u) => {
        const r = await fetchPage(u);
        if (r.error || !r.html) throw new Error(r.error ?? "empty response");
        return r.html;
      },
    });
  };
}

export async function runGoal(
  goal: Goal,
  opts: RunOptions = {}
): Promise<RunResult> {
  const dryRun = opts.dryRun ?? true;
  const persistAudit = opts.persistAudit ?? true;
  const breakers = makeBreakers({
    maxCostUsd: goal.constraints.maxCostUsd,
    ...opts.breakers,
  });

  // Audit is best-effort: a failing audit write must never abort or corrupt the
  // analysis. createRun failure degrades to an unaudited run rather than throwing.
  let runId: string | null = null;
  if (persistAudit) {
    try {
      runId = await createRun(goal);
    } catch (e) {
      warn("createRun failed; continuing without audit", e);
    }
  }
  const actions: ActionRecord[] = [];
  let pagesTouched = 0;
  const record = async (a: ActionRecord) => {
    actions.push(a);
    if (runId) {
      try {
        await recordAction(runId, a);
      } catch (e) {
        warn("recordAction failed", e);
      }
    }
  };

  try {
    // PERCEIVE — no LLM.
    const urls = await resolveTargetUrls(goal);
    const perceived: PerceivedPage[] = [];
    for (const url of urls) {
      const scan = await processPage(url, "scan");
      perceived.push(toPerceived(goal, url, scan));
    }

    // PLAN — deterministic.
    const { queue, skipped } = planTasks(goal, perceived);
    for (const url of skipped) {
      await record({
        url,
        action: "skip",
        schemaBefore: null,
        schemaAfter: null,
        gates: null,
        outcome: "already_satisfied",
      });
    }

    // ACT — stage + gate each queued page. Breakers can halt the loop early
    // (e.g. a run of consecutive failures) before any live write happens.
    const satisfied: string[] = [...skipped];
    const unsatisfied: string[] = [];
    const entries: SnippetEntry[] = [];
    const applyItems: ApplyItem[] = [];
    let haltedBy: BreakerReason | undefined;

    for (const task of queue) {
      const ex = await executeTask(goal, task);
      pagesTouched += 1;
      await record(ex.action);
      if (ex.satisfied) {
        satisfied.push(ex.url);
        if (ex.entry) {
          entries.push(ex.entry);
          applyItems.push({ url: ex.url, entry: ex.entry });
        }
      } else {
        unsatisfied.push(ex.url);
      }

      recordOutcome(breakers, {
        success: ex.satisfied,
        costUsd: ex.action.costUsd ?? 0,
      });
      const verdict = tripped(breakers);
      if (verdict.halted) {
        haltedBy = verdict.reason;
        warn("circuit breaker halted the run", verdict.detail ?? verdict.reason);
        break;
      }
    }

    const stagedSnippet = entries.length
      ? renderSchemaGenSnippet(entries)
      : null;

    // LIVE APPLY (Phase 3) — only when not dry-run, nothing halted us, and we have
    // verified-stageable entries. Dry-run returns here with apply:null, unchanged.
    let apply: ApplyResult | null = null;
    if (!dryRun && !haltedBy && applyItems.length > 0) {
      const themeId = resolveWriteThemeId();
      const { shop } = getShopifyConfig();
      apply = await applyEntries({
        runId,
        themeId,
        shop,
        items: applyItems,
        ops: makeShopifyOps(),
        verify: makeLiveVerify(goal.target, themeId),
        persistBackup: (assetKey, valueBefore) =>
          backupRow(runId, shop, themeId, assetKey, valueBefore),
      });
      for (const a of apply.actions) await record(a);
      // A rollback that itself failed pages the user — never thrash on the next run.
      if (apply.status === "paged") recordRollbackFailure(breakers);
    }

    // Map the run outcome. The persisted agent_runs.status is constrained to
    // done|failed; the richer RunResult.status (rolled_back/paged) is for callers.
    const ranClean = unsatisfied.length === 0 && !haltedBy;
    let status: RunResult["status"];
    if (apply && apply.status !== "applied") {
      status = apply.status === "paged" ? "paged" : "rolled_back";
    } else {
      status = ranClean ? "done" : "failed";
    }
    const dbStatus: "done" | "failed" = status === "done" ? "done" : "failed";
    const error =
      apply?.status === "paged"
        ? `rollback failed; theme left dirty: ${apply.error ?? "unknown"}`
        : haltedBy
          ? `halted by circuit breaker: ${haltedBy}`
          : null;

    if (runId) {
      try {
        await finishRun(runId, {
          status: dbStatus,
          iterations: 1,
          pagesTouched,
          costUsd: breakers.costUsd,
          error,
        });
      } catch (e) {
        warn("finishRun failed", e);
      }
    }

    return {
      runId,
      status,
      iterations: 1,
      pagesTouched,
      satisfied,
      unsatisfied,
      skipped,
      stagedSnippet,
      apply,
      haltedBy,
      actions,
    };
  } catch (err) {
    // A non-audit failure (e.g. resolveTargetUrls). Record real progress, don't
    // overwrite it with zeros, and don't let finishRun's own failure mask err.
    if (runId) {
      try {
        await finishRun(runId, {
          status: "failed",
          iterations: 1,
          pagesTouched,
          costUsd: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch (e) {
        warn("finishRun (failure path) failed", e);
      }
    }
    throw err;
  }
}
