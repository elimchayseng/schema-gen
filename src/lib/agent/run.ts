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
import { getShopifyConfig, normalizeShop } from "@/lib/shopify/config";
import type { SnippetEntry } from "@/lib/shopify/snippet";
import type { PageResult } from "@/lib/crawl/types";
import { planTasks } from "./planner";
import { executeTask } from "./executor";
import { hasCriticalIssue } from "./gates";
import { l4Verify } from "./verify";
import { applyEntries, makeShopifyOps, type ApplyItem } from "./apply";
import {
  getStorefrontCookie,
  isStorefrontPasswordConfigured,
  looksPasswordGated,
} from "@/lib/shopify/storefront-password";
import {
  makeBreakers,
  recordOutcome,
  recordRollbackFailure,
  tripped,
} from "./breakers";
import { createRun, finishRun, loadCommittedUrls, recordAction } from "./audit";
import { chunk, clampConcurrency } from "./concurrency";

function warn(msg: string, e: unknown): void {
  console.warn(`[agent] ${msg}: ${e instanceof Error ? e.message : String(e)}`);
}
import type {
  ActionRecord,
  AgentProgressEvent,
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
function makeLiveVerify(target: GoalTarget, themeId: number, shop: string) {
  // Dev stores (and any store with the storefront password on) redirect every
  // unauthenticated request to /password, so L4 would never see the rendered schema.
  // Obtain the storefront_digest cookie once (when SHOPIFY_STOREFRONT_PASSWORD is set)
  // and send it on every verify fetch so the real page renders.
  let cookiePromise: Promise<string | null> | null = null;
  const getCookie = () => {
    if (!cookiePromise) cookiePromise = getStorefrontCookie(shop);
    return cookiePromise;
  };

  return (url: string, _entry: SnippetEntry) => {
    void _entry;
    const previewUrl = `${url}${url.includes("?") ? "&" : "?"}preview_theme_id=${themeId}`;
    return l4Verify({
      url: previewUrl,
      requireTypes: target.requireTypes,
      minOutcome: target.minOutcome,
      fetchHtml: async (u) => {
        const cookie = await getCookie();
        const r = await fetchPage(u, cookie ? { headers: { Cookie: cookie } } : {});
        if (r.error || !r.html) throw new Error(r.error ?? "empty response");
        // Turn the silent "no JSON-LD rendered" rollback into an actionable cause when
        // the storefront is password-gated and we couldn't authenticate past it.
        if (looksPasswordGated(r.finalUrl, r.html)) {
          throw new Error(
            isStorefrontPasswordConfigured()
              ? "storefront is password-protected and the configured SHOPIFY_STOREFRONT_PASSWORD was rejected"
              : "storefront is password-protected — set SHOPIFY_STOREFRONT_PASSWORD (Online Store → Preferences) or disable the storefront password so the live page can be verified"
          );
        }
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
  const concurrency = clampConcurrency(opts.concurrency);
  const resume = opts.resume ?? true;
  const judge = opts.judge ?? false;
  const breakers = makeBreakers({
    maxCostUsd: goal.constraints.maxCostUsd,
    ...opts.breakers,
  });

  // Audit is best-effort: a failing audit write must never abort or corrupt the
  // analysis. A caller-supplied runId (the control surface creates the run first so it
  // can poll control immediately) is used as-is; otherwise createRun failure degrades to
  // an unaudited run rather than throwing.
  let runId: string | null = opts.runId ?? null;
  if (persistAudit && !runId) {
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

  // Progress is best-effort: a throwing onProgress must never abort the run.
  const emit = (ev: AgentProgressEvent) => {
    if (!opts.onProgress) return;
    try {
      opts.onProgress(ev);
    } catch (e) {
      warn("onProgress threw (continuing)", e);
    }
  };
  // Cooperative cancellation. A thrown shouldHalt is treated as "not killed" (a transient
  // control-read error must not halt a healthy run; readControl already swallows its own).
  const killRequested = async (): Promise<boolean> => {
    if (opts.signal?.aborted) return true;
    if (opts.shouldHalt) {
      try {
        return (await opts.shouldHalt()) === "kill";
      } catch (e) {
        warn("shouldHalt threw (continuing)", e);
        return false;
      }
    }
    return false;
  };

  try {
    // PERCEIVE — no LLM. A kill between batches stops here; nothing has been written.
    let urls = await resolveTargetUrls(goal);

    // Idempotent resume (Phase 5): drop pages this run already committed live (an
    // l4_pass verify row). A resumed run never re-processes them; a fresh run has none,
    // so this is inert. Best-effort — loadCommittedUrls degrades to empty on any error.
    const committedSkipped: string[] = [];
    if (resume && runId) {
      const committed = await loadCommittedUrls(runId);
      if (committed.size > 0) {
        for (const u of urls) {
          if (!committed.has(u)) continue;
          committedSkipped.push(u);
          await record({
            url: u,
            action: "skip",
            schemaBefore: null,
            schemaAfter: null,
            gates: null,
            outcome: "already_committed",
          });
        }
        urls = urls.filter((u) => !committed.has(u));
      }
    }

    // Storefront-password auth for perceive + execute. A Shopify dev store (or any store
    // with "Password protect this store" on) 302-redirects every storefront request to
    // /password, so processPage would only ever see the password wall. Obtain the
    // storefront_digest cookie once (same one L4 verify uses; getStorefrontCookie caches
    // per-shop in-process) and attach it ONLY to fetches on the configured shop host —
    // public sites in the goal are still fetched anonymously. Best-effort: no password
    // configured, or any failure, degrades to anonymous fetches (the prior behavior).
    let shopHost = "";
    let storefrontCookie: string | null = null;
    try {
      shopHost = normalizeShop(getShopifyConfig().shop);
      storefrontCookie = await getStorefrontCookie(getShopifyConfig().shop);
    } catch {
      shopHost = "";
      storefrontCookie = null;
    }
    const headersFor = (u: string): Record<string, string> | undefined => {
      if (!storefrontCookie || !shopHost) return undefined;
      try {
        if (normalizeShop(new URL(u).hostname) === shopHost) {
          return { Cookie: storefrontCookie };
        }
      } catch {
        /* unparseable URL → fetch anonymously */
      }
      return undefined;
    };

    emit({ phase: "perceive", runId, perceived: 0, queued: 0 });
    const perceived: PerceivedPage[] = [];
    let killed = false;
    // Bounded fan-out: scan up to `concurrency` pages at once, fold results in order so
    // progress events stay deterministic. Kill is honored before each batch.
    for (const batch of chunk(urls, concurrency)) {
      if (await killRequested()) {
        killed = true;
        break;
      }
      const scans = await Promise.all(
        batch.map((u) => processPage(u, "scan", undefined, { fetchHeaders: headersFor(u) }))
      );
      for (let i = 0; i < batch.length; i++) {
        perceived.push(toPerceived(goal, batch[i], scans[i]));
        emit({ phase: "perceive", url: batch[i], perceived: perceived.length });
      }
    }

    // PLAN + ACT only run if we weren't killed during perceive.
    const satisfied: string[] = [...committedSkipped];
    const unsatisfied: string[] = [];
    const entries: SnippetEntry[] = [];
    const applyItems: ApplyItem[] = [];
    let skipped: string[] = [...committedSkipped];
    let haltedBy: BreakerReason | undefined;

    if (!killed) {
      // PLAN — deterministic.
      const planned = planTasks(goal, perceived);
      skipped = [...committedSkipped, ...planned.skipped];
      satisfied.push(...planned.skipped);
      emit({
        phase: "plan",
        queued: planned.queue.length,
        satisfied: satisfied.length,
      });
      for (const url of planned.skipped) {
        await record({
          url,
          action: "skip",
          schemaBefore: null,
          schemaAfter: null,
          gates: null,
          outcome: "already_satisfied",
        });
      }

      // ACT — stage + gate each queued page, up to `concurrency` at a time. Results are
      // folded in queue order, so the consecutive-failure breaker behaves exactly as it
      // did sequentially. A breaker trip OR a kill halts the loop early — both before any
      // live write. Kill is honored before each batch (per-batch granularity); the
      // load-bearing pre-apply checkpoint still guarantees no half-written theme.
      for (const batch of chunk(planned.queue, concurrency)) {
        if (await killRequested()) {
          killed = true;
          break;
        }
        const results = await Promise.all(
          batch.map((task) =>
            executeTask(goal, task, { judge, fetchHeaders: headersFor(task.url) })
          )
        );
        let halted = false;
        for (const ex of results) {
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
          emit({
            phase: "act",
            url: ex.url,
            gates: ex.action.gates,
            outcome: ex.action.outcome,
            // The repaired JSON-LD this page would inject — surfaced inline so the UI can
            // show a per-product schema dropdown in the preview.
            schemaAfter: ex.action.schemaAfter,
            acted: pagesTouched,
            satisfied: satisfied.length,
            unsatisfied: unsatisfied.length,
          });

          recordOutcome(breakers, {
            success: ex.satisfied,
            costUsd: ex.action.costUsd ?? 0,
          });
          const verdict = tripped(breakers);
          if (verdict.halted) {
            haltedBy = verdict.reason;
            warn("circuit breaker halted the run", verdict.detail ?? verdict.reason);
            halted = true;
            break;
          }
        }
        if (halted) break;
      }
    }

    const stagedSnippet = entries.length
      ? renderSchemaGenSnippet(entries)
      : null;

    // PRE-APPLY KILL CHECKPOINT (the load-bearing guarantee). The apply path is atomic
    // and is never interrupted once entered, so the ONLY safe place to honor a kill is
    // right here, before the first write. A kill caught here means nothing was written
    // and there is nothing to roll back — "kill leaves no half-written theme" by
    // construction.
    if (!killed && !haltedBy && !dryRun && applyItems.length > 0) {
      if (await killRequested()) killed = true;
    }

    // LIVE APPLY (Phase 3) — only when not dry-run, nothing halted us, not killed, and we
    // have verified-stageable entries. Dry-run returns here with apply:null, unchanged.
    let apply: ApplyResult | null = null;
    if (!dryRun && !haltedBy && !killed && applyItems.length > 0) {
      emit({ phase: "apply", queued: applyItems.length });
      const themeId = resolveWriteThemeId();
      const { shop } = getShopifyConfig();
      apply = await applyEntries({
        runId,
        themeId,
        shop,
        items: applyItems,
        ops: makeShopifyOps(),
        verify: makeLiveVerify(goal.target, themeId, shop),
        persistBackup: (assetKey, valueBefore) =>
          backupRow(runId, shop, themeId, assetKey, valueBefore),
      });
      for (const a of apply.actions) await record(a);
      // A rollback that itself failed pages the user — never thrash on the next run.
      if (apply.status === "paged") recordRollbackFailure(breakers);
      emit({ phase: "apply", applyStatus: apply.status });
    }

    // Map the run outcome. The persisted agent_runs.status is constrained to
    // done|failed; the richer RunResult.status (rolled_back/paged) is for callers. A kill
    // finalizes as failed but is surfaced separately via RunResult.killed.
    const ranClean = unsatisfied.length === 0 && !haltedBy && !killed;
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
        : killed
          ? "run killed by control signal"
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

    emit({
      phase: "done",
      runId,
      applyStatus: apply?.status,
      satisfied: satisfied.length,
      unsatisfied: unsatisfied.length,
      message: killed ? "killed" : undefined,
    });

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
      killed,
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
