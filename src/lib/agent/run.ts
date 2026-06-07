/**
 * runGoal — the agent loop entry point (plan §3). Perceive → plan → act, in
 * dry-run. The LLM only runs inside the executor's processPage("optimize"); the
 * planner and every gate are deterministic. Nothing is written to Shopify in
 * Phase 2 — the staged snippet that *would* be written is returned for diffing.
 */
import { processPage } from "@/lib/crawl/process-page";
import { fetchSitemap } from "@/lib/crawl/sitemap";
import { createAdminClient } from "@/lib/supabase";
import { getRichResultInfo } from "@/lib/validation/rich-results";
import { renderSchemaGenSnippet, urlToTemplateTarget } from "@/lib/shopify/snippet";
import type { PageResult } from "@/lib/crawl/types";
import { planTasks } from "./planner";
import { executeTask } from "./executor";
import { hasCriticalIssue } from "./gates";
import { createRun, finishRun, recordAction } from "./audit";

function warn(msg: string, e: unknown): void {
  console.warn(`[agent] ${msg}: ${e instanceof Error ? e.message : String(e)}`);
}
import type {
  ActionRecord,
  Goal,
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

export async function runGoal(
  goal: Goal,
  opts: RunOptions = {}
): Promise<RunResult> {
  const dryRun = opts.dryRun ?? true;
  if (!dryRun) {
    throw new Error("Live apply (dryRun: false) is not available until Phase 3");
  }
  const persistAudit = opts.persistAudit ?? true;

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

    // ACT — dry-run: stage + gate, never publish.
    const satisfied: string[] = [...skipped];
    const unsatisfied: string[] = [];
    const entries = [];
    for (const task of queue) {
      const ex = await executeTask(goal, task);
      pagesTouched += 1;
      await record(ex.action);
      if (ex.satisfied) {
        satisfied.push(ex.url);
        if (ex.entry) entries.push(ex.entry);
      } else {
        unsatisfied.push(ex.url);
      }
    }

    const stagedSnippet = entries.length
      ? renderSchemaGenSnippet(entries)
      : null;
    const status = unsatisfied.length === 0 ? "done" : "failed";

    if (runId) {
      try {
        await finishRun(runId, {
          status,
          iterations: 1,
          pagesTouched,
          costUsd: 0,
          error: null,
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
