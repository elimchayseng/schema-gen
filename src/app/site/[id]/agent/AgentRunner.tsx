"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  AgentProgressEvent,
  ApplyResult,
  GateResult,
  GateResults,
  GoalScope,
  MinOutcome,
} from "@/lib/agent";

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
  error?: string;
}

interface PageRow {
  url: string;
  gates: GateResults | null;
}

const SCOPES: { value: GoalScope; label: string }[] = [
  { value: "all_products", label: "All products" },
  { value: "all_pages", label: "All pages" },
  { value: "url_list", label: "Specific URLs" },
];

/** A single gate verdict chip. null = gate not applicable for this goal. */
function GateChip({ level, result }: { level: string; result: GateResult | null | undefined }) {
  const base = "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium";
  if (result == null) {
    return <span className={`${base} bg-slate-100 text-slate-400`} title="not applicable">{level} n/a</span>;
  }
  return result.passed ? (
    <span className={`${base} bg-emerald-100 text-emerald-700`} title={result.detail ?? "passed"}>{level} ✓</span>
  ) : (
    <span className={`${base} bg-red-100 text-red-700`} title={result.detail ?? "failed"}>{level} ✗</span>
  );
}

function GateRow({ gates }: { gates: GateResults | null }) {
  if (!gates) return <span className="text-xs text-slate-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      <GateChip level="L0" result={gates.L0} />
      <GateChip level="L1" result={gates.L1} />
      <GateChip level="L2" result={gates.L2} />
      <GateChip level="L3" result={gates.L3} />
      <GateChip level="L4" result={gates.L4} />
    </div>
  );
}

export default function AgentRunner({
  crawlId,
  siteId,
  domain,
}: {
  crawlId: string;
  siteId: string;
  domain: string;
}) {
  const [scope, setScope] = useState<GoalScope>("all_products");
  const [requireTypesInput, setRequireTypesInput] = useState("Product");
  const [minOutcome, setMinOutcome] = useState<MinOutcome>("rich_results_eligible");
  const [urlsInput, setUrlsInput] = useState("");
  const [dryRun, setDryRun] = useState(true);

  const [running, setRunning] = useState(false);
  const [killing, setKilling] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [counts, setCounts] = useState({ perceived: 0, queued: 0, acted: 0, satisfied: 0, unsatisfied: 0 });
  const [rows, setRows] = useState<Record<string, PageRow>>({});
  const [summary, setSummary] = useState<DoneSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel the in-flight stream if the operator navigates away mid-run, so the fetch
  // (and, via the route's cancel hook, the server-side run) doesn't dangle.
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleEvent = useCallback((data: Record<string, unknown>) => {
    if (data.step === "done") {
      setSummary(data as unknown as DoneSummary);
      setPhase("done");
      return;
    }
    if (data.step === "error") {
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
    setCounts((prev) => ({
      perceived: ev.perceived ?? prev.perceived,
      queued: ev.queued ?? prev.queued,
      acted: ev.acted ?? prev.acted,
      satisfied: ev.satisfied ?? prev.satisfied,
      unsatisfied: ev.unsatisfied ?? prev.unsatisfied,
    }));
    if (ev.phase === "act" && ev.url) {
      setRows((prev) => ({ ...prev, [ev.url as string]: { url: ev.url as string, gates: ev.gates ?? null } }));
    }
  }, []);

  const startRun = useCallback(async () => {
    setRunning(true);
    setError(null);
    setSummary(null);
    setRows({});
    setRunId(null);
    runIdRef.current = null;
    setPhase(null);
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
        body: JSON.stringify({ siteId, dryRun, target }),
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
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setRunning(false);
    }
  }, [siteId, dryRun, scope, requireTypesInput, minOutcome, urlsInput, handleEvent]);

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
      // best-effort; the run loop will also stop on disconnect
    } finally {
      setKilling(false);
    }
  }, []);

  const rowList = Object.values(rows);

  return (
    <div className="min-h-screen bg-slate-50 px-6 py-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6">
          <Link href={`/site/${crawlId}`} className="text-sm text-indigo-600 hover:text-indigo-800">
            ← Back to dashboard
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-slate-900">Agent</h1>
          <p className="text-sm text-slate-500">{domain}</p>
        </div>

        {/* Goal form */}
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-700">Goal</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Scope</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as GoalScope)}
                disabled={running}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
              >
                {SCOPES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Minimum outcome</span>
              <select
                value={minOutcome}
                onChange={(e) => setMinOutcome(e.target.value as MinOutcome)}
                disabled={running}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
              >
                <option value="valid">Valid</option>
                <option value="rich_results_eligible">Rich-results eligible</option>
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-slate-600">Required schema types (comma-separated)</span>
              <input
                value={requireTypesInput}
                onChange={(e) => setRequireTypesInput(e.target.value)}
                disabled={running}
                placeholder="Product"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
              />
            </label>
            {scope === "url_list" && (
              <label className="block sm:col-span-2">
                <span className="text-xs font-medium text-slate-600">URLs (one per line)</span>
                <textarea
                  value={urlsInput}
                  onChange={(e) => setUrlsInput(e.target.value)}
                  disabled={running}
                  rows={4}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs disabled:bg-slate-100"
                />
              </label>
            )}
          </div>

          {/* Dry-run toggle */}
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={dryRun}
              onClick={() => setDryRun((v) => !v)}
              disabled={running}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${dryRun ? "bg-indigo-600" : "bg-slate-300"}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${dryRun ? "translate-x-6" : "translate-x-1"}`} />
            </button>
            <span className="text-sm text-slate-700">
              Dry run {dryRun ? "on" : "off"}
            </span>
          </div>
          {dryRun && (
            <div className="mt-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
              DRY RUN — schemas are staged and gated, but nothing is written to the theme.
            </div>
          )}

          {/* Controls */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              onClick={startRun}
              disabled={running}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {running ? "Running…" : "Start run"}
            </button>
            <button
              onClick={kill}
              disabled={!running || !runId || killing}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
            >
              {killing ? "Killing…" : "Kill"}
            </button>
            <button
              disabled
              title="Coming in Phase 5"
              className="cursor-not-allowed rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-400"
            >
              Pause
            </button>
            <button
              disabled
              title="Coming in Phase 5"
              className="cursor-not-allowed rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-400"
            >
              Resume
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Live progress */}
        {(running || phase) && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">Progress</h2>
              {phase && (
                <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
                  {phase}
                </span>
              )}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3 text-center text-xs sm:grid-cols-5">
              {([
                ["Perceived", counts.perceived],
                ["Queued", counts.queued],
                ["Acted", counts.acted],
                ["Satisfied", counts.satisfied],
                ["Unsatisfied", counts.unsatisfied],
              ] as const).map(([label, n]) => (
                <div key={label} className="rounded-md bg-slate-50 px-2 py-2">
                  <div className="text-lg font-semibold text-slate-900">{n}</div>
                  <div className="text-slate-500">{label}</div>
                </div>
              ))}
            </div>

            {rowList.length > 0 && (
              <div className="mt-4 divide-y divide-slate-100">
                {rowList.map((r) => (
                  <div key={r.url} className="flex items-center justify-between gap-3 py-2">
                    <span className="truncate font-mono text-xs text-slate-600" title={r.url}>{r.url}</span>
                    <GateRow gates={r.gates} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Summary + diff preview */}
        {summary && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-700">Result</h2>
              <StatusBadge summary={summary} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-4">
              <div><dt className="text-slate-400">Pages touched</dt><dd className="font-medium text-slate-900">{summary.pagesTouched}</dd></div>
              <div><dt className="text-slate-400">Satisfied</dt><dd className="font-medium text-slate-900">{summary.satisfied.length}</dd></div>
              <div><dt className="text-slate-400">Unsatisfied</dt><dd className="font-medium text-slate-900">{summary.unsatisfied.length}</dd></div>
              <div><dt className="text-slate-400">Mode</dt><dd className="font-medium text-slate-900">{summary.dryRun ? "Dry run" : "Live"}</dd></div>
            </dl>

            {summary.apply && (
              <div className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Apply status: <span className="font-medium text-slate-900">{summary.apply.status}</span>
                {" "}({summary.apply.l4.filter((v) => v?.passed).length}/{summary.apply.l4.length} L4 passed)
              </div>
            )}

            {summary.stagedSnippet && (
              <details className="mt-4" open={summary.dryRun}>
                <summary className="cursor-pointer text-xs font-medium text-indigo-600">
                  Diff preview — snippet that {summary.dryRun ? "would be" : "was"} written
                </summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
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

function StatusBadge({ summary }: { summary: DoneSummary }) {
  const { status, killed } = summary;
  const label = killed ? "killed" : status;
  const cls = killed
    ? "bg-red-100 text-red-700"
    : status === "done"
      ? "bg-emerald-100 text-emerald-700"
      : status === "rolled_back"
        ? "bg-amber-100 text-amber-700"
        : "bg-red-100 text-red-700";
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}
