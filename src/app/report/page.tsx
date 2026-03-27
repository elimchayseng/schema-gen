"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useScan } from "@/components/ScanProvider";
import ScanProgress from "@/components/ScanProgress";
import ScoreHero from "@/components/report/ScoreHero";
import DeployBar from "@/components/report/DeployBar";
import SchemaRow from "@/components/report/SchemaRow";
import { computeScore } from "@/lib/scoring/compute-score";

export default function ReportPage() {
  const router = useRouter();
  const { step, results, error, url } = useScan();

  const score = useMemo(() => {
    if (!results) return null;
    return computeScore(results);
  }, [results]);

  // Loading state
  if (step !== "idle" && step !== "done" && step !== "error") {
    return <ScanProgress currentStep={step} />;
  }

  // Error state
  if (step === "error" || error) {
    return (
      <div className="mx-auto max-w-2xl pt-12">
        <div className="rounded-lg border border-error/30 bg-error-dim/20 px-5 py-4">
          <p className="text-sm text-error">{error ?? "Something went wrong"}</p>
        </div>
        <button
          onClick={() => router.push("/")}
          className="mt-4 text-sm text-text-secondary hover:text-text-primary"
        >
          &larr; Try another URL
        </button>
      </div>
    );
  }

  // No results yet — redirect to home
  if (!results || !score) {
    router.push("/");
    return null;
  }

  const hasLLMFailure = results.notes.some((n) =>
    n.includes("AI generation failed")
  );

  return (
    <div className="mx-auto max-w-3xl">
      {/* URL breadcrumb */}
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={() => router.push("/")}
          className="text-xs text-text-muted hover:text-text-secondary"
        >
          &larr; New scan
        </button>
        <span className="font-mono text-xs text-text-muted truncate max-w-lg">
          {results.finalUrl || url}
        </span>
        {results.pageType && (
          <span className="rounded-sm bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-text-secondary">
            {results.pageType}
          </span>
        )}
      </div>

      {/* Score */}
      <ScoreHero score={score} />

      {/* LLM failure warning */}
      {hasLLMFailure && (
        <div className="mb-4 rounded-md border border-warn/30 bg-warn-dim/20 px-4 py-3 text-xs text-warn">
          AI generation was unavailable. Showing scan and auto-fix results only.
        </div>
      )}

      {/* Deploy bar — primary action zone */}
      <DeployBar
        comparisons={results.comparisons}
        newRecommendations={results.newRecommendations}
      />

      {/* Schema inventory */}
      {(results.comparisons.length > 0 ||
        results.newRecommendations.length > 0) && (
        <div className="rounded-lg border border-border overflow-hidden mb-6">
          <div className="px-5 py-3 bg-surface-1 border-b border-border">
            <h2 className="text-xs font-bold uppercase tracking-wider text-text-muted">
              Schema Inventory
            </h2>
          </div>

          {/* Existing / optimized schemas */}
          {results.comparisons.map((c, i) => (
            <SchemaRow
              key={`c-${i}`}
              comparison={c}
              sourceUrl={results.url}
            />
          ))}

          {/* New recommendations */}
          {results.newRecommendations.map((rec, i) => (
            <SchemaRow
              key={`r-${i}`}
              recommendation={rec}
              sourceUrl={results.url}
              isNew
            />
          ))}
        </div>
      )}

      {/* Missing opportunities */}
      {results.missingOpportunities.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-text-muted">
            Additional Opportunities
          </h2>
          <div className="flex flex-col gap-1">
            {results.missingOpportunities.map((opp, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-md bg-surface-1 px-4 py-2.5"
              >
                <span className="font-mono text-xs font-medium text-text-primary">
                  {opp.schemaType}
                </span>
                <span className="flex-1 text-xs text-text-secondary">
                  {opp.reason}
                </span>
                <span
                  className={`font-mono text-[10px] uppercase ${
                    opp.confidence === "high"
                      ? "text-valid"
                      : opp.confidence === "medium"
                        ? "text-warn"
                        : "text-text-muted"
                  }`}
                >
                  {opp.confidence}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      {results.notes.length > 0 &&
        !results.notes.every((n) => n.includes("AI generation failed")) && (
          <div className="mb-6">
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-text-muted">
              Notes
            </h2>
            <ul className="flex flex-col gap-1">
              {results.notes
                .filter((n) => !n.includes("AI generation failed"))
                .map((note, i) => (
                  <li key={i} className="text-xs text-text-secondary">
                    {note}
                  </li>
                ))}
            </ul>
          </div>
        )}

      {/* Empty state */}
      {results.comparisons.length === 0 &&
        results.newRecommendations.length === 0 && (
          <div className="rounded-lg border border-border bg-surface-1 p-8 text-center">
            <p className="text-sm text-text-secondary">
              No schema markup found or generated for this page. Try a different
              URL or a page with more structured content.
            </p>
          </div>
        )}
    </div>
  );
}
