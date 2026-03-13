"use client";

import { useState } from "react";
import type { OptimizeResponse } from "@/lib/optimizer/types";
import type { ValidatedRecommendation } from "@/lib/ai/types";
import ComparisonCard from "@/components/optimizer/ComparisonCard";
import DeployPanel from "@/components/optimizer/DeployPanel";
import IssueRow from "@/components/IssueRow";
import { copyJsonLdScript } from "@/lib/copy-utils";
import { saveSchema } from "@/lib/save-schema";

// ─── New Recommendation Card ────────────────────────────────────────────────

function NewRecommendationCard({
  rec,
  sourceUrl,
}: {
  rec: ValidatedRecommendation;
  sourceUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);

  async function handleCopy() {
    const ok = await copyJsonLdScript(JSON.stringify(rec.jsonld, null, 2));
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  }

  async function handleSave() {
    setSaving(true);
    try {
      let hostname = "";
      try {
        hostname = new URL(sourceUrl).hostname;
      } catch {
        hostname = sourceUrl;
      }

      const result = await saveSchema({
        name: `${rec.type} from ${hostname}`,
        schema_type: rec.type,
        content: rec.jsonld,
        source_url: sourceUrl,
      });

      if (result.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-white">{rec.type}</span>
          <span className="rounded-full bg-blue-900/40 px-2 py-0.5 text-[10px] font-semibold uppercase text-blue-400">
            New
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
              rec.priority === 1
                ? "bg-emerald-900/40 text-emerald-400"
                : rec.priority === 2
                  ? "bg-amber-900/40 text-amber-400"
                  : "bg-zinc-800 text-zinc-400"
            }`}
          >
            {rec.priority === 1
              ? "Primary"
              : rec.priority === 2
                ? "Recommended"
                : "Optional"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          {saved ? (
            <span className="rounded-md bg-emerald-900/40 px-3 py-1 text-xs font-medium text-emerald-400">
              Saved
            </span>
          ) : (
            <button
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          )}
        </div>
      </div>

      <p className="mb-3 text-sm text-zinc-400">{rec.rationale}</p>

      {/* Validation issues */}
      {rec.validation.errors.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {rec.validation.errors.map((e, i) => (
            <IssueRow key={i} issue={e} />
          ))}
        </div>
      )}

      {rec.validation.valid && rec.validation.warnings.length === 0 && (
        <p className="mb-3 text-xs text-emerald-400">
          No issues found. This schema is valid.
        </p>
      )}

      <pre className="mb-3 max-h-80 overflow-auto rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-200">
        {JSON.stringify(rec.jsonld, null, 2)}
      </pre>

      {/* Shopify instructions */}
      <div>
        <button
          onClick={() => setInstructionsExpanded((v) => !v)}
          className="text-xs text-indigo-400 underline-offset-2 hover:underline"
        >
          {instructionsExpanded ? "Hide" : "Show"} Shopify placement
          instructions
        </button>
        {instructionsExpanded && (
          <div className="mt-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-300">
            {rec.shopifyInstructions}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function OptimizerPage() {
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<OptimizeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleOptimize(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setIsLoading(true);
    setError(null);
    setResults(null);

    try {
      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Optimization failed");
        return;
      }

      setResults(data as OptimizeResponse);
    } catch {
      setError("Network error — please try again");
    } finally {
      setIsLoading(false);
    }
  }

  // Compute summary stats
  const existingCount = results?.comparisons.filter((c) => c.existing).length ?? 0;
  const totalIssues =
    results?.comparisons.reduce((sum, c) => {
      const errs = c.existing?.validation.errors.length ?? 0;
      const warns = c.existing?.validation.warnings.length ?? 0;
      return sum + errs + warns;
    }, 0) ?? 0;
  const resolvedCount =
    results?.comparisons.reduce((sum, c) => {
      const fixerResolved = c.fixed?.resolvedFromOriginal.length ?? 0;
      const aiResolved = c.generated?.resolvedFromOriginal.length ?? 0;
      return sum + Math.max(fixerResolved, aiResolved);
    }, 0) ?? 0;

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Schema Optimizer</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Scan, fix, and enhance your schema markup in one step. Enter a URL to
          see what exists, what we can auto-fix, and what AI recommends.
        </p>
      </div>

      {/* URL input */}
      <form onSubmit={handleOptimize} className="mb-8 flex gap-3">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/products/tee"
          required
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={isLoading}
          className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
        >
          {isLoading ? "Optimizing..." : "Optimize"}
        </button>
      </form>

      {/* Error */}
      {error && (
        <div className="mb-6 rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-indigo-500" />
          Scanning page and generating optimized schemas...
        </div>
      )}

      {/* Results */}
      {results && !isLoading && (
        <div>
          {/* Summary bar */}
          <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">
                Page type:
              </span>
              <span className="rounded-full bg-zinc-800 px-3 py-0.5 text-xs font-medium text-zinc-300">
                {results.pageType}
              </span>
            </div>
            <span className="text-zinc-600">|</span>
            <span className="text-sm text-zinc-400">
              {existingCount} existing schema
              {existingCount !== 1 ? "s" : ""}
            </span>
            {totalIssues > 0 && (
              <>
                <span className="text-zinc-600">|</span>
                <span className="text-sm text-red-400">
                  {totalIssues} issue{totalIssues !== 1 ? "s" : ""} found
                </span>
              </>
            )}
            {resolvedCount > 0 && (
              <>
                <span className="text-zinc-600">|</span>
                <span className="text-sm text-emerald-400">
                  {resolvedCount} resolved
                </span>
              </>
            )}
          </div>

          {/* LLM failure warning */}
          {results.notes.some((n) => n.includes("AI generation failed")) && (
            <div className="mb-6 rounded-lg border border-amber-800 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
              AI generation was unavailable. Showing scan and auto-fix results
              only.
            </div>
          )}

          {/* Comparison cards */}
          {results.comparisons.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Existing Schemas
              </h2>
              <div className="flex flex-col gap-4">
                {results.comparisons.map((c, i) => (
                  <ComparisonCard
                    key={i}
                    comparison={c}
                    sourceUrl={results.url}
                  />
                ))}
              </div>
            </div>
          )}

          {/* New recommendations */}
          {results.newRecommendations.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                New Recommendations
              </h2>
              <div className="flex flex-col gap-4">
                {results.newRecommendations.map((rec, i) => (
                  <NewRecommendationCard
                    key={i}
                    rec={rec}
                    sourceUrl={results.url}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Missing opportunities */}
          {results.missingOpportunities.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Additional Opportunities
              </h2>
              <div className="flex flex-col gap-2">
                {results.missingOpportunities.map((opp, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3"
                  >
                    <span className="shrink-0 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold text-zinc-300">
                      {opp.schemaType}
                    </span>
                    <span className="text-sm text-zinc-400">{opp.reason}</span>
                    <span
                      className={`ml-auto shrink-0 text-[10px] font-medium uppercase ${
                        opp.confidence === "high"
                          ? "text-emerald-400"
                          : opp.confidence === "medium"
                            ? "text-amber-400"
                            : "text-zinc-500"
                      }`}
                    >
                      {opp.confidence}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Deploy panel */}
          <div className="mb-8">
            <DeployPanel
              comparisons={results.comparisons}
              newRecommendations={results.newRecommendations}
            />
          </div>

          {/* Notes */}
          {results.notes.length > 0 &&
            !results.notes.every((n) => n.includes("AI generation failed")) && (
              <div className="mb-8">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Notes
                </h2>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                  <ul className="flex flex-col gap-2">
                    {results.notes
                      .filter((n) => !n.includes("AI generation failed"))
                      .map((note, i) => (
                        <li key={i} className="text-sm text-zinc-400">
                          {note}
                        </li>
                      ))}
                  </ul>
                </div>
              </div>
            )}

          {/* Empty state: no schemas found at all */}
          {results.comparisons.length === 0 &&
            results.newRecommendations.length === 0 && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-8 text-center">
                <p className="text-sm text-zinc-400">
                  No schema markup found or generated for this page. Try a
                  different URL or a page with more structured content.
                </p>
              </div>
            )}
        </div>
      )}
    </div>
  );
}
