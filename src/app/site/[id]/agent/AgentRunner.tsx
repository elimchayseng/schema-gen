"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
// Value import MUST come from the pure leaf module, not the @/lib/agent barrel: the
// barrel re-exports runGoal/audit → supabase → node:crypto, which a client bundle can't
// resolve. Types from the barrel are fine (erased at compile time).
import { groupRunPages, type RunPageGroups } from "@/lib/agent/run-grouping";
import SchemaTweakPanel from "@/components/agent/SchemaTweakPanel";
import type {
  AgentProgressEvent,
  ApplyResult,
  GateResult,
  GateResults,
  GoalScope,
  MinOutcome,
  StagingOutcome,
} from "@/lib/agent";

/**
 * The most recent agent_runs row for this site, fetched server-side by page.tsx so a
 * remount (reload, navigation) shows where the last run ended instead of a blank form.
 * `last_step` is the persisted uniform step checkpoint (migration 013) — null until
 * the migration is applied or for runs predating it.
 */
export interface LastRun {
  id: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  error: string | null;
  last_step?: {
    phase?: string;
    step?: string | null;
    status?: string | null;
    url?: string | null;
    detail?: string | null;
    at?: string | null;
  } | null;
}

interface DoneSummary {
  status: string;
  killed: boolean;
  dryRun: boolean;
  pagesTouched: number;
  satisfied: string[];
  unsatisfied: string[];
  skipped: string[];
  haltedBy: string | null;
  stagedSnippet: string | null;
  apply: ApplyResult | null;
  /** Staging-mode outcome (issue #26): preview URL, publish state, rollback theme. */
  staging?: StagingOutcome | null;
  error?: string;
}

/**
 * Client-side write-target modes, mirroring the run route's string enum. Staging
 * modes duplicate the published theme and need the site provisioned with Shopify
 * credentials (sites.shop_domain); "env" is the test-theme behavior.
 */
const WRITE_MODES: { value: string; label: string; needsShop: boolean }[] = [
  { value: "env", label: "Test theme (safe default)", needsShop: false },
  { value: "staging", label: "Staging preview (duplicate of live theme)", needsShop: true },
  { value: "staging_publish", label: "Staging + auto-publish when verified", needsShop: true },
];

/** An acted page, as observed on the live stream. */
interface PageRow {
  url: string;
  gates: GateResults | null;
  outcome?: string;
  /** The exact JSON-LD that would be injected for this page (from the stream). */
  schemaAfter?: unknown;
}

/** Lazily-loaded per-page before/after, fetched from the run-detail endpoint on expand. */
interface PageDetail {
  before: unknown;
  after: unknown;
  outcome?: string;
}
type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; byUrl: Record<string, PageDetail> };

const SCOPES: { value: GoalScope; label: string }[] = [
  { value: "all_products", label: "All products" },
  { value: "all_pages", label: "All pages" },
  { value: "url_list", label: "Specific URLs" },
];

/** Plain-language names for the deterministic gates (L0–L4). */
const GATE_LABELS: Record<string, string> = {
  L0: "Built",
  L1: "Valid",
  L2: "Rich-eligible",
  L3: "No-regression",
  L4: "Live-verified",
};

const GATE_ORDER: (keyof GateResults)[] = ["L0", "L1", "L2", "L3", "L4"];

/** Google's free Rich Results Test, deep-linked to a page — the customer's proof. */
function richResultsTestUrl(pageUrl: string): string {
  return `https://search.google.com/test/rich-results?url=${encodeURIComponent(pageUrl)}`;
}

/** A single gate verdict chip. null = gate not applicable for this goal/phase. */
function GateChip({ level, result }: { level: keyof GateResults; result: GateResult | null | undefined }) {
  const label = GATE_LABELS[level] ?? level;
  const base = "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium";
  if (result == null) {
    return (
      <span className={`${base} bg-surface-2 text-text-muted`} aria-label={`${label}: not checked`}>
        {label} n/a
      </span>
    );
  }
  const state = result.passed ? "passed" : "failed";
  const aria = `${label}: ${state}${result.detail ? ` — ${result.detail}` : ""}`;
  return result.passed ? (
    <span className={`${base} bg-valid/15 text-accent-bright`} aria-label={aria}>{label} ✓</span>
  ) : (
    <span className={`${base} bg-error/15 text-error`} aria-label={aria}>{label} ✗</span>
  );
}

function GateRow({ gates }: { gates: GateResults | null }) {
  if (!gates) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {GATE_ORDER.map((lvl) => (
        <GateChip key={lvl} level={lvl} result={gates[lvl]} />
      ))}
    </div>
  );
}

/** The first failing gate (or AI error) for a page, as visible text — never hover-only. */
function rowReason(row: PageRow | undefined): string | null {
  if (!row) return null;
  if (row.outcome?.startsWith("processing_failed")) {
    return row.outcome.replace(/^processing_failed:\s*/, "AI error: ");
  }
  const g = row.gates;
  if (g) {
    for (const lvl of GATE_ORDER) {
      const res = g[lvl];
      if (res && !res.passed) {
        return `${GATE_LABELS[lvl]} failed${res.detail ? ` — ${res.detail}` : ""}`;
      }
    }
  }
  return null;
}

type VerdictTone = "success" | "error" | "warning" | "neutral";

const TONE_CLASSES: Record<VerdictTone, string> = {
  success: "border-valid/40 bg-valid/10",
  error: "border-error/30 bg-error/10",
  warning: "border-warn/30 bg-warn/10",
  neutral: "border-border bg-surface-1",
};

function haltSentence(haltedBy: string, failed: number, notReached: number): string {
  const rest =
    notReached > 0
      ? ` The remaining ${notReached} ${notReached === 1 ? "page was" : "pages were"} not reached.`
      : "";
  switch (haltedBy) {
    case "consecutive_failures":
      return `${failed} ${failed === 1 ? "page" : "pages"} failed in a row, so the agent halted to avoid wasting the rest.${rest}`;
    case "max_cost_exceeded":
      return `The run hit its cost limit and stopped.${rest}`;
    case "rollback_failed":
      return `A rollback failed, so the run stopped to avoid making it worse.${rest}`;
    default:
      return `The run halted early.${rest}`;
  }
}

interface Verdict {
  tone: VerdictTone;
  title: string;
  detail: string;
}

/** Map a finished run + its page groups to a single plain-English verdict. */
function buildVerdict(summary: DoneSummary, groups: RunPageGroups): Verdict {
  const fixed = groups.fixed.length;
  const failed = groups.failed.length;
  const notReached = groups.notReached.length;
  const alreadyGood = groups.alreadyGood.length;
  const total = fixed + failed + notReached + alreadyGood;
  const needed = fixed + failed + notReached;

  if (summary.killed) {
    return {
      tone: "neutral",
      title: "Run stopped",
      detail: "You stopped this run before it finished. Nothing was written to the theme.",
    };
  }
  if (summary.apply?.status === "rolled_back") {
    return {
      tone: "warning",
      title: "Changes rolled back — your store is untouched",
      detail: "A live check failed after writing, so the agent restored the store exactly as it was. No broken schema is live.",
    };
  }
  if (total === 0) {
    return {
      tone: "neutral",
      title: "No pages found",
      detail: "The scan returned no pages. Check the domain, or run with Specific URLs.",
    };
  }
  if (needed === 0) {
    return {
      tone: "success",
      title: "Everything already looks great",
      detail: `All ${alreadyGood} ${alreadyGood === 1 ? "page" : "pages"} already had valid structured data — nothing to fix.`,
    };
  }
  if (summary.haltedBy) {
    return {
      tone: "error",
      title: `Stopped early — ${fixed} of ${needed} fixed`,
      detail: haltSentence(summary.haltedBy, failed, notReached),
    };
  }
  if (failed > 0) {
    return {
      tone: "warning",
      title: `${fixed} of ${needed} pages ready · ${failed} need a look`,
      detail: "Most pages are Google-ready. A few couldn't be fixed automatically — see the reason on each below.",
    };
  }
  if (summary.dryRun) {
    return {
      tone: "success",
      title: `${fixed} ${fixed === 1 ? "page is" : "pages are"} ready to go live`,
      detail: "This is a preview — we validated valid, rich-eligible structured data for every page. Nothing is written yet. Review below, then apply.",
    };
  }
  return {
    tone: "success",
    title: `Done — ${fixed} ${fixed === 1 ? "page is" : "pages are"} now Google-ready`,
    detail: "Valid, rich-eligible structured data was written to your store and verified on the live page. Confirm it yourself with Google's Rich Results Test below.",
  };
}

export default function AgentRunner({
  crawlId,
  siteId,
  domain,
  hasShopCredentials = false,
  lastRun = null,
}: {
  crawlId: string;
  siteId: string;
  domain: string;
  /** True when the site row carries shop_domain — unlocks the staging write modes. */
  hasShopCredentials?: boolean;
  /** The site's most recent run, for the rehydrate-on-mount "Last run" card. */
  lastRun?: LastRun | null;
}) {
  const [scope, setScope] = useState<GoalScope>("all_products");
  const [writeMode, setWriteMode] = useState("env");
  // Staging progress (issue #26): the duplicate's preview URL + the latest stage/publish note.
  const [stageInfo, setStageInfo] = useState<{ message?: string; previewUrl?: string }>({});
  const [requireTypesInput, setRequireTypesInput] = useState("Product");
  const [minOutcome, setMinOutcome] = useState<MinOutcome>("rich_results_eligible");
  const [urlsInput, setUrlsInput] = useState("");
  // The active run's mode, set by which button was pressed. Preview = dry run (nothing
  // written); Apply = live write. Driven by buttons, never a raw toggle the user must reason about.
  const [lastDryRun, setLastDryRun] = useState(true);

  const [running, setRunning] = useState(false);
  const [killing, setKilling] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [counts, setCounts] = useState({ perceived: 0, queued: 0, acted: 0, satisfied: 0, unsatisfied: 0 });
  const [rows, setRows] = useState<Record<string, PageRow>>({});
  const [perceivedUrls, setPerceivedUrls] = useState<string[]>([]);
  const [summary, setSummary] = useState<DoneSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });

  const runIdRef = useRef<string | null>(null);
  // True once a terminal stream event (done/error) arrived — distinguishes a clean
  // finish from a severed connection that needs the poll fallback.
  const terminalRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const requireTypesRef = useRef<HTMLInputElement | null>(null);

  // Cancel the in-flight stream fetch if the operator navigates away mid-run. The
  // server-side run deliberately continues (disconnect ≠ kill); its result persists
  // and is visible in the report / run history.
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleEvent = useCallback((data: Record<string, unknown>) => {
    if (data.step === "done") {
      terminalRef.current = true;
      setSummary(data as unknown as DoneSummary);
      setPhase("done");
      return;
    }
    if (data.step === "error") {
      terminalRef.current = true;
      setError(String(data.error ?? "Run failed"));
      setPhase("done");
      return;
    }
    const ev = data as unknown as AgentProgressEvent;
    if (ev.runId) {
      setRunId(ev.runId);
      runIdRef.current = ev.runId;
    }
    if (ev.phase) setPhase(ev.phase);
    // Staging events (issue #26): keep the latest message; the previewUrl is sticky once
    // it arrives so the "see your staged store" link survives later events.
    if (ev.phase === "stage" || ev.phase === "publish") {
      setStageInfo((prev) => ({
        message: ev.message ?? prev.message,
        previewUrl: ev.previewUrl ?? prev.previewUrl,
      }));
    }
    setCounts((prev) => ({
      perceived: ev.perceived ?? prev.perceived,
      queued: ev.queued ?? prev.queued,
      acted: ev.acted ?? prev.acted,
      satisfied: ev.satisfied ?? prev.satisfied,
      unsatisfied: ev.unsatisfied ?? prev.unsatisfied,
    }));
    // Accumulate every URL we observe so the done view can account for not-reached pages.
    if (ev.url) {
      const url = ev.url;
      setPerceivedUrls((prev) => (prev.includes(url) ? prev : [...prev, url]));
    }
    if (ev.phase === "act" && ev.url) {
      const url = ev.url;
      setRows((prev) => ({
        ...prev,
        [url]: { url, gates: ev.gates ?? null, outcome: ev.outcome, schemaAfter: ev.schemaAfter },
      }));
    }
  }, []);

  /**
   * Poll fallback: the SSE connection died but the run is still going server-side
   * (the HTTP stack severs long streams — Node's requestTimeout is ~300s — and a
   * staging duplicate alone can take longer). The run row is the durable truth:
   * poll it until terminal and synthesize a degraded done-state that points the
   * operator at the full report instead of a dead "network error".
   */
  const pollUntilDone = useCallback(
    async (id: string, runDryRun: boolean, ac: AbortController) => {
      setStageInfo((prev) => ({
        ...prev,
        message:
          "live connection dropped — the run is still going on the server; checking for the result…",
      }));
      const MAX_POLLS = 240; // 5s apart ≈ 20 minutes, far beyond any observed run
      for (let i = 0; i < MAX_POLLS && !ac.signal.aborted; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        let run: { status?: string; error?: string | null; pages_touched?: number | null } | null = null;
        try {
          const res = await fetch(`/api/agent/run/${id}`);
          if (!res.ok) continue;
          run = (await res.json()).run ?? null;
        } catch {
          continue; // transient — the run row will still be there next poll
        }
        if (!run?.status || run.status === "running") continue;
        terminalRef.current = true;
        if (run.status === "done") {
          setSummary({
            status: "done",
            killed: false,
            dryRun: runDryRun,
            pagesTouched: run.pages_touched ?? 0,
            satisfied: [],
            unsatisfied: [],
            skipped: [],
            haltedBy: null,
            stagedSnippet: null,
            apply: null,
            staging: null,
          });
          setStageInfo((prev) => ({
            ...prev,
            message:
              "the run finished while disconnected — page-level results are in the full report below",
          }));
        } else {
          setError(run.error ?? "Run failed");
        }
        setPhase("done");
        return;
      }
      if (!ac.signal.aborted) {
        setError(
          "lost the live connection and the run hasn't finished — it may still be running; check the report page or run history"
        );
      }
    },
    []
  );

  const startRun = useCallback(
    async (runDryRun: boolean) => {
      setRunning(true);
      setLastDryRun(runDryRun);
      setError(null);
      setSummary(null);
      setRows({});
      setPerceivedUrls([]);
      setExpanded(new Set());
      setDetail({ status: "idle" });
      setRunId(null);
      runIdRef.current = null;
      terminalRef.current = false;
      setPhase(null);
      setStageInfo({});
      setCounts({ perceived: 0, queued: 0, acted: 0, satisfied: 0, unsatisfied: 0 });

      const requireTypes = requireTypesInput.split(",").map((s) => s.trim()).filter(Boolean);
      const target: Record<string, unknown> = { scope, requireTypes, minOutcome };
      if (scope === "url_list") {
        target.urls = urlsInput.split(/\s+/).map((s) => s.trim()).filter(Boolean);
      }

      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch("/api/agent/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteId, dryRun: runDryRun, target, writeTheme: writeMode }),
          signal: ac.signal,
        });
        if (!res.ok) {
          const msg = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          setError(msg.error ?? `HTTP ${res.status}`);
          return;
        }
        if (!res.body) {
          setError("No response stream");
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            if (!chunk.startsWith("data: ")) continue;
            try {
              handleEvent(JSON.parse(chunk.slice(6)));
            } catch {
              // skip malformed chunk
            }
          }
        }
        // Stream ended without a terminal event: the connection was severed
        // mid-run (not a failure of the run itself) — fall back to polling.
        if (!terminalRef.current && runIdRef.current && !ac.signal.aborted) {
          await pollUntilDone(runIdRef.current, runDryRun, ac);
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          if (!terminalRef.current && runIdRef.current) {
            await pollUntilDone(runIdRef.current, runDryRun, ac);
          } else {
            setError(e instanceof Error ? e.message : String(e));
          }
        }
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        setRunning(false);
      }
    },
    [siteId, scope, requireTypesInput, minOutcome, urlsInput, writeMode, handleEvent, pollUntilDone]
  );

  const kill = useCallback(async () => {
    const id = runIdRef.current;
    if (!id) return;
    setKilling(true);
    try {
      await fetch(`/api/agent/run/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ control: "kill" }),
      });
    } catch {
      // best-effort; the control flag is the only kill channel (disconnect ≠ kill)
    } finally {
      setKilling(false);
    }
  }, []);

  // Lazy-load per-page before/after from the run-detail endpoint, once, on first expand.
  const loadDetail = useCallback(async () => {
    const id = runIdRef.current;
    if (!id) {
      setDetail({ status: "error" });
      return;
    }
    setDetail({ status: "loading" });
    try {
      const res = await fetch(`/api/agent/run/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { actions?: Record<string, unknown>[] };
      const byUrl: Record<string, PageDetail> = {};
      for (const a of json.actions ?? []) {
        const url = String(a.url ?? "");
        if (!url) continue;
        byUrl[url] = {
          before: a.schema_before ?? null,
          after: a.schema_after ?? null,
          outcome: a.outcome as string | undefined,
        };
      }
      setDetail({ status: "ready", byUrl });
    } catch {
      setDetail({ status: "error" });
    }
  }, []);

  const toggleRow = useCallback(
    (url: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(url)) next.delete(url);
        else next.add(url);
        return next;
      });
      setDetail((d) => {
        if (d.status === "idle" || d.status === "error") {
          // fire-and-forget; loadDetail sets its own state
          void loadDetail();
          return { status: "loading" };
        }
        return d;
      });
    },
    [loadDetail]
  );

  const focusGoal = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    requireTypesRef.current?.focus();
  }, []);

  const groups = summary
    ? groupRunPages({
        satisfied: summary.satisfied,
        unsatisfied: summary.unsatisfied,
        skipped: summary.skipped,
        perceivedUrls,
      })
    : null;
  const verdict = summary && groups ? buildVerdict(summary, groups) : null;
  const leadGroup: keyof RunPageGroups | null = groups
    ? groups.failed.length > 0 || summary?.haltedBy
      ? "failed"
      : groups.fixed.length > 0
        ? "fixed"
        : groups.alreadyGood.length > 0
          ? "alreadyGood"
          : "notReached"
    : null;

  const liveRows = Object.values(rows);

  // After a clean PREVIEW that staged real fixes, the next step is to apply them live.
  const canApply =
    !!summary &&
    summary.dryRun &&
    !summary.killed &&
    !summary.haltedBy &&
    !!groups &&
    groups.fixed.length > 0;
  const appliedLive = !!summary && !summary.dryRun && summary.apply?.status === "applied";

  return (
    <div className="min-h-screen bg-surface-0 px-6 py-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8">
          <Link href={`/site/${crawlId}`} className="text-sm text-accent hover:text-accent-bright">
            ← Back to dashboard
          </Link>
          <h1 className="mt-4 font-serif text-3xl text-text-primary">
            Make your products Google-ready
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-secondary">
            SchemaGen reads every product page on{" "}
            <span className="font-mono text-text-primary">{domain}</span>, writes valid
            structured data, fixes anything Google would reject, and proves it on the live
            page — so your products can show rich results and AI shopping tools can read them.
          </p>
        </div>

        {/* Primary action card — dead simple: one button starts a safe preview. */}
        <div className="rounded-lg border border-border bg-surface-card p-6 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-text-primary">
                Step 1 — Preview the changes
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                See exactly what we&apos;ll add to each page. Nothing is written to your store yet.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {running ? (
                <button
                  onClick={kill}
                  disabled={!runId || killing}
                  className="rounded-md bg-error px-5 py-3 text-sm font-bold text-surface-0 transition-all hover:opacity-90 disabled:opacity-40"
                >
                  {killing ? "Stopping…" : "Stop"}
                </button>
              ) : (
                <button
                  onClick={() => startRun(true)}
                  className="btn-optimize rounded-md bg-accent px-6 py-3 text-sm font-bold text-surface-0 transition-all hover:bg-accent-bright"
                >
                  Preview changes
                </button>
              )}
            </div>
          </div>

          {/* Advanced — hidden by default so the common path is one click. */}
          <details className="mt-5 border-t border-border pt-4">
            <summary className="cursor-pointer text-xs font-medium text-text-muted hover:text-text-secondary">
              Advanced settings
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-text-secondary">Scope</span>
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as GoalScope)}
                  disabled={running}
                  className="mt-1 w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary disabled:opacity-50"
                >
                  {SCOPES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-text-secondary">Minimum outcome</span>
                <select
                  value={minOutcome}
                  onChange={(e) => setMinOutcome(e.target.value as MinOutcome)}
                  disabled={running}
                  className="mt-1 w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary disabled:opacity-50"
                >
                  <option value="valid">Valid</option>
                  <option value="rich_results_eligible">Rich-results eligible</option>
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className="text-xs font-medium text-text-secondary">Write target (live runs)</span>
                <select
                  value={writeMode}
                  onChange={(e) => setWriteMode(e.target.value)}
                  disabled={running}
                  className="mt-1 w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary disabled:opacity-50"
                >
                  {WRITE_MODES.map((m) => (
                    <option key={m.value} value={m.value} disabled={m.needsShop && !hasShopCredentials}>
                      {m.label}
                      {m.needsShop && !hasShopCredentials ? " — connect your Shopify store first" : ""}
                    </option>
                  ))}
                </select>
                {!hasShopCredentials && (
                  <span className="mt-1 block text-[11px] text-text-muted">
                    Staging modes duplicate your live theme and need the store connected
                    (provision with your Shopify app credentials).
                  </span>
                )}
              </label>
              <label className="block sm:col-span-2">
                <span className="text-xs font-medium text-text-secondary">Required schema types (comma-separated)</span>
                <input
                  ref={requireTypesRef}
                  value={requireTypesInput}
                  onChange={(e) => setRequireTypesInput(e.target.value)}
                  disabled={running}
                  placeholder="Product"
                  className="mt-1 w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder-text-muted disabled:opacity-50"
                />
              </label>
              {scope === "url_list" && (
                <label className="block sm:col-span-2">
                  <span className="text-xs font-medium text-text-secondary">URLs (one per line)</span>
                  <textarea
                    value={urlsInput}
                    onChange={(e) => setUrlsInput(e.target.value)}
                    disabled={running}
                    rows={4}
                    className="mt-1 w-full rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-xs text-text-primary disabled:opacity-50"
                  />
                </label>
              )}
            </div>
          </details>
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-error/30 bg-error-dim/20 px-4 py-3 text-sm text-error">
            {error}
          </div>
        )}

        {/* Last run (rehydrate-on-mount): a remount wipes the in-memory result card,
            but the run itself is durable — point back at it instead of a blank page. */}
        {!running && !summary && !error && lastRun && (
          <div className="mt-4 rounded-lg border border-border bg-surface-card p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-text-primary">Last run</h2>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  lastRun.status === "done"
                    ? "bg-valid-dim/40 text-valid"
                    : lastRun.status === "running"
                      ? "bg-fix/20 text-fix-bright"
                      : "bg-error-dim/20 text-error"
                }`}
              >
                {lastRun.status}
              </span>
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              {lastRun.ended_at
                ? `Finished ${new Date(lastRun.ended_at).toLocaleString()}`
                : lastRun.started_at
                  ? `Started ${new Date(lastRun.started_at).toLocaleString()}`
                  : ""}
              {lastRun.last_step?.step && (
                <>
                  {" · last checkpoint: "}
                  <span className="font-mono">
                    {lastRun.last_step.step}
                    {lastRun.last_step.status ? ` ${lastRun.last_step.status}` : ""}
                  </span>
                </>
              )}
              {lastRun.error && <span className="text-error"> · {lastRun.error}</span>}
            </p>
            <div className="mt-3">
              <Link
                href={`/site/${crawlId}/agent/report/${lastRun.id}`}
                className="inline-block rounded-md bg-fix px-4 py-2 text-xs font-bold text-text-primary transition-all hover:bg-fix-bright"
              >
                View the full report →
              </Link>
            </div>
          </div>
        )}

        {/* Live progress (while running, before the done summary lands) */}
        {running && !summary && (
          <div className="mt-4 rounded-lg border border-border bg-surface-card p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">
                {lastDryRun ? "Previewing changes…" : "Applying to your store…"}
              </h2>
              {phase && (
                <span className="rounded-full bg-fix/20 px-2.5 py-0.5 text-xs font-medium text-fix-bright">
                  {phase}
                </span>
              )}
            </div>
            {(phase === "stage" || phase === "publish" || stageInfo.message) && (
              <div className="mt-3 rounded-md border border-fix/30 bg-fix/10 px-3 py-2 text-xs text-text-secondary">
                <span className="font-medium text-fix-bright">
                  {phase === "publish" ? "Publishing" : "Staging"}:
                </span>{" "}
                {stageInfo.message ?? "working…"}
                {stageInfo.previewUrl && (
                  <a
                    href={stageInfo.previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-2 font-medium text-fix-bright underline hover:no-underline"
                  >
                    Preview your staged store ↗
                  </a>
                )}
              </div>
            )}
            <div className="mt-3 grid grid-cols-3 gap-3 text-center text-xs sm:grid-cols-5">
              {([
                ["Found", counts.perceived],
                ["Queued", counts.queued],
                ["Processed", counts.acted],
                ["Ready", counts.satisfied],
                ["Need work", counts.unsatisfied],
              ] as const).map(([label, n]) => (
                <div key={label} className="rounded-md bg-surface-2 px-2 py-2">
                  <div className="text-lg font-semibold text-text-primary">{n}</div>
                  <div className="text-text-muted">{label}</div>
                </div>
              ))}
            </div>

            {liveRows.length > 0 && (
              <div className="mt-4 divide-y divide-border">
                {liveRows.map((r) => (
                  <div key={r.url} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <span className="break-all font-mono text-xs text-text-secondary sm:truncate" title={r.url}>{r.url}</span>
                    <GateRow gates={r.gates} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Result — verdict, reason, next steps, grouped pages */}
        {summary && groups && verdict && (
          <div className={`mt-4 rounded-lg border p-6 shadow-sm ${TONE_CLASSES[verdict.tone]}`}>
            <h2 className="text-lg font-semibold text-text-primary">{verdict.title}</h2>
            <p className="mt-1 text-sm text-text-secondary">{verdict.detail}</p>

            {/* The merchant-readable report — the "you're good to go" artifact. */}
            {runId && (
              <div className="mt-4">
                <Link
                  href={`/site/${crawlId}/agent/report/${runId}`}
                  className="inline-block rounded-md bg-fix px-5 py-2.5 text-sm font-bold text-text-primary transition-all hover:bg-fix-bright"
                >
                  View the full report →
                </Link>
              </div>
            )}

            {/* Staging outcome (issue #26) — preview link, publish state, rollback note. */}
            {summary.staging && (
              <div className="mt-4 rounded-md border border-fix/30 bg-fix/10 p-4 text-xs text-text-secondary">
                {summary.staging.published ? (
                  <>
                    <span className="font-semibold text-text-primary">
                      Your verified theme is live.
                    </span>{" "}
                    The previous theme (#{summary.staging.rollbackThemeId}) is kept in
                    Online Store → Themes — republishing it undoes everything instantly.
                  </>
                ) : summary.staging.deleted ? (
                  <>
                    The staging theme was removed after the run rolled back — your live
                    store was never touched.
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-text-primary">
                      Your changes are on a staged copy of the live theme.
                    </span>{" "}
                    <a
                      href={summary.staging.previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-fix-bright underline hover:no-underline"
                    >
                      Preview the staged store ↗
                    </a>{" "}
                    — publish theme #{summary.staging.stagingThemeId} in Online Store →
                    Themes when you&apos;re happy.
                  </>
                )}
              </div>
            )}

            {/* The headline next step: apply a clean preview to the live store. */}
            {canApply && (
              <div className="mt-4 rounded-md border border-accent/20 bg-accent/5 p-4">
                <h3 className="text-sm font-semibold text-text-primary">
                  Step 2 — Apply to your store
                </h3>
                <p className="mt-1 text-xs text-text-secondary">
                  Writes the previewed structured data to your test theme, then re-checks the
                  live page. If anything fails to render, it&apos;s rolled back automatically — your
                  store is never left broken.
                </p>
                <button
                  onClick={() => startRun(false)}
                  disabled={running}
                  className="btn-optimize mt-3 rounded-md bg-accent px-5 py-2.5 text-sm font-bold text-surface-0 transition-all hover:bg-accent-bright disabled:opacity-50"
                >
                  Apply to my store
                </button>
              </div>
            )}

            {/* Post-apply proof — let the customer verify on Google themselves. */}
            {appliedLive && groups.fixed.length > 0 && (
              <div className="mt-4 rounded-md border border-accent/20 bg-accent/5 p-4">
                <h3 className="text-sm font-semibold text-text-primary">Prove it on Google</h3>
                <p className="mt-1 text-xs text-text-secondary">
                  Open any updated page in Google&apos;s free Rich Results Test — it should now read
                  <span className="text-accent-bright"> Eligible</span>.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {groups.fixed.slice(0, 3).map((url) => (
                    <a
                      key={url}
                      href={richResultsTestUrl(url)}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md border border-accent/40 bg-transparent px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10"
                    >
                      Test a page on Google ↗
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* Next steps — only when something went wrong */}
            {(verdict.tone === "error" || verdict.tone === "warning") && (
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => startRun(lastDryRun)}
                  disabled={running}
                  className="rounded-md bg-fix px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-fix-bright disabled:opacity-50"
                >
                  Try again
                </button>
                <button
                  onClick={focusGoal}
                  className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2"
                >
                  Adjust settings
                </button>
              </div>
            )}

            {/* Counts */}
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-text-secondary sm:grid-cols-4">
              <div><dt className="text-text-muted">Ready</dt><dd className="font-medium text-text-primary">{groups.fixed.length}</dd></div>
              <div><dt className="text-text-muted">Need work</dt><dd className="font-medium text-text-primary">{groups.failed.length}</dd></div>
              <div><dt className="text-text-muted">Already good</dt><dd className="font-medium text-text-primary">{groups.alreadyGood.length}</dd></div>
              <div><dt className="text-text-muted">Mode</dt><dd className="font-medium text-text-primary">{summary.dryRun ? "Preview" : "Live"}</dd></div>
            </dl>
            {summary.apply && (
              <div className="mt-3 rounded-md bg-surface-1 px-3 py-2 text-xs text-text-secondary">
                Apply status: <span className="font-medium text-text-primary">{summary.apply.status}</span>
                {" "}({summary.apply.l4.filter((v) => v?.passed).length}/{summary.apply.l4.length} live-verified)
              </div>
            )}

            {/* Pages — grouped, with a legend for the gate chips */}
            <div className="mt-5 rounded-lg border border-border bg-surface-1 p-4">
              <p className="text-xs text-text-muted">
                Each page runs these checks in order:{" "}
                <b className="text-text-secondary">Built</b> → <b className="text-text-secondary">Valid</b> → <b className="text-text-secondary">Rich-eligible</b> → <b className="text-text-secondary">No-regression</b> → <b className="text-text-secondary">Live-verified</b>.{" "}
                <span className="text-accent-bright">✓ pass</span> · <span className="text-error">✗ fail</span> ·{" "}
                <span className="text-text-muted">n/a not checked</span>.
              </p>

              <div className="mt-3 space-y-2">
                <GroupSection
                  title="Need work"
                  emoji="⚠️"
                  urls={groups.failed}
                  rows={rows}
                  open={leadGroup === "failed"}
                  expandable
                  expanded={expanded}
                  detail={detail}
                  onToggle={toggleRow}
                  siteId={siteId}
                />
                <GroupSection
                  title="Not reached"
                  emoji="⏸"
                  urls={groups.notReached}
                  rows={rows}
                  open={leadGroup === "notReached"}
                  hint="The run halted before these pages."
                  expanded={expanded}
                  detail={detail}
                  onToggle={toggleRow}
                />
                <GroupSection
                  title={summary.dryRun ? "Ready to apply" : "Made Google-ready"}
                  emoji="✅"
                  urls={groups.fixed}
                  rows={rows}
                  open={leadGroup === "fixed"}
                  expandable
                  expanded={expanded}
                  detail={detail}
                  onToggle={toggleRow}
                  siteId={siteId}
                />
                <GroupSection
                  title="Already good"
                  emoji="⏭"
                  urls={groups.alreadyGood}
                  rows={rows}
                  open={leadGroup === "alreadyGood"}
                  hint="These already had valid schema — nothing to do."
                  expanded={expanded}
                  detail={detail}
                  onToggle={toggleRow}
                />
              </div>
            </div>

            {summary.stagedSnippet && (
              <details className="mt-4">
                <summary className="cursor-pointer text-xs font-medium text-accent">
                  View the exact code — what {summary.dryRun ? "would be" : "was"} written to your theme
                </summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-surface-0 p-3 text-[11px] leading-relaxed text-text-secondary">
                  {summary.stagedSnippet}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A collapsible group of pages (Need work / Not reached / Ready / Already good). */
function GroupSection({
  title,
  emoji,
  urls,
  rows,
  open,
  hint,
  expandable,
  expanded,
  detail,
  onToggle,
  siteId,
}: {
  title: string;
  emoji: string;
  urls: string[];
  rows: Record<string, PageRow>;
  open: boolean;
  hint?: string;
  expandable?: boolean;
  expanded: Set<string>;
  detail: DetailState;
  onToggle: (url: string) => void;
  /** Enables the per-page "Refine with AI" tweak panel when provided. */
  siteId?: string;
}) {
  if (urls.length === 0) return null;
  return (
    <details open={open} className="rounded-md border border-border">
      <summary className="flex min-h-[44px] cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium text-text-primary">
        <span aria-hidden>{emoji}</span>
        <span>{title}</span>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-secondary">{urls.length}</span>
      </summary>
      {hint && <p className="px-3 pb-2 text-xs text-text-muted">{hint}</p>}
      <div className="divide-y divide-border border-t border-border">
        {urls.map((url) => (
          <PageRowItem
            key={url}
            url={url}
            row={rows[url]}
            expandable={!!expandable}
            isExpanded={expanded.has(url)}
            detail={detail}
            onToggle={onToggle}
            siteId={siteId}
          />
        ))}
      </div>
    </details>
  );
}

function PageRowItem({
  url,
  row,
  expandable,
  isExpanded,
  detail,
  onToggle,
  siteId,
}: {
  url: string;
  row: PageRow | undefined;
  expandable: boolean;
  isExpanded: boolean;
  detail: DetailState;
  onToggle: (url: string) => void;
  siteId?: string;
}) {
  const reason = rowReason(row);

  const header = (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <span className="break-all font-mono text-xs text-text-secondary sm:truncate" title={url}>{url}</span>
      {row?.gates && <GateRow gates={row.gates} />}
    </div>
  );

  return (
    <div className="px-3 py-2">
      {expandable ? (
        <button
          type="button"
          onClick={() => onToggle(url)}
          aria-expanded={isExpanded}
          className="flex min-h-[44px] w-full flex-col justify-center gap-1 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {header}
        </button>
      ) : (
        <div className="min-h-[36px]">{header}</div>
      )}

      {reason && <p className="mt-1 text-xs text-warn">{reason}</p>}

      {expandable && isExpanded && (
        <div className="mt-2">
          <PageDetailView url={url} detail={detail} injected={row?.schemaAfter} siteId={siteId} />
        </div>
      )}
    </div>
  );
}

/** Primary @type of a staged JSON-LD value (first object's type) — for the tweak panel. */
function primarySchemaType(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === null || typeof first !== "object") return null;
  const t = (first as Record<string, unknown>)["@type"];
  if (typeof t === "string") return t;
  if (Array.isArray(t) && typeof t[0] === "string") return t[0];
  return null;
}

function PageDetailView({
  url,
  detail,
  injected,
  siteId,
}: {
  url: string;
  detail: DetailState;
  injected: unknown;
  siteId?: string;
}) {
  // The injected schema comes straight off the live stream, so it renders instantly with
  // no spinner or DB round-trip — this is the "what will be added to this product" view.
  const dbDetail = detail.status === "ready" ? detail.byUrl[url] : undefined;
  const before = dbDetail?.before;
  // Fall back to the DB "after" only if the stream didn't carry one (older runs).
  const injectedValue =
    injected != null && !(Array.isArray(injected) && injected.length === 0)
      ? injected
      : dbDetail?.after;

  // A saved merchant correction (issue #29) comes back from the chat endpoint as
  // the post-edit document. Fold it in: otherwise the preview above and the next
  // chat request both keep using the stale pre-correction JSON-LD. The tweak is
  // pinned to the document it edited — a re-run that streams a fresh schemaAfter
  // (new object reference) discards the stale correction instead of masking it.
  const [tweaked, setTweaked] = useState<{ base: unknown; value: unknown } | null>(null);
  const shownValue =
    tweaked && tweaked.base === injectedValue ? tweaked.value : injectedValue;

  const tweakType = primarySchemaType(shownValue);

  return (
    <div className="space-y-2">
      <SchemaBlock label="Structured data to be injected" value={shownValue} highlight />
      {before != null && (Array.isArray(before) ? before.length > 0 : true) && (
        <SchemaBlock label="Before (current page)" value={before} />
      )}
      {detail.status === "loading" && before == null && (
        <p className="text-xs text-text-muted">Loading the page&apos;s current schema…</p>
      )}
      {/* Optional merchant correction (issue #29) — sticky overrides via chat. Collapsed
          by default: the default flow needs no merchant input. */}
      {siteId && tweakType && shownValue != null && (
        <details className="rounded-md border border-fix/30">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-fix-bright">
            Refine with AI — correct anything that&apos;s wrong (optional)
          </summary>
          <div className="border-t border-fix/20 p-3">
            <SchemaTweakPanel
              siteId={siteId}
              url={url}
              schemaType={tweakType}
              jsonld={shownValue}
              onUpdated={(v) => setTweaked({ base: injectedValue, value: v })}
            />
          </div>
        </details>
      )}
    </div>
  );
}

function SchemaBlock({
  label,
  value,
  highlight,
}: {
  label: string;
  value: unknown;
  highlight?: boolean;
}) {
  const text =
    value == null || (Array.isArray(value) && value.length === 0)
      ? "—"
      : JSON.stringify(value, null, 2);
  return (
    <div>
      <div
        className={`mb-1 text-[11px] font-medium uppercase tracking-wide ${highlight ? "text-accent-bright" : "text-text-muted"}`}
      >
        {label}
      </div>
      <pre
        className={`max-h-72 overflow-auto rounded-md p-2 text-[11px] leading-relaxed text-text-secondary ${highlight ? "bg-surface-0 ring-1 ring-accent/20" : "bg-surface-0"}`}
      >
        {text}
      </pre>
    </div>
  );
}
