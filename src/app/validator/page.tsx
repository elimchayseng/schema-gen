"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { UrlScanResult, SchemaValidationSummary, MissingOpportunity } from "@/lib/url-validator";
import type { ValidationIssue } from "@/lib/validation/types";

// ─── Status helpers ────────────────────────────────────────────────────────

function statusColor(valid: boolean, errorCount: number, warningCount: number) {
  if (errorCount > 0) return "text-red-400";
  if (warningCount > 0) return "text-amber-400";
  return "text-emerald-400";
}

function statusDot(valid: boolean, errorCount: number) {
  if (errorCount > 0) return "bg-red-500";
  if (!valid) return "bg-amber-500";
  return "bg-emerald-500";
}

// ─── Sub-components ───────────────────────────────────────────────────────

function IssueRow({ issue }: { issue: ValidationIssue }) {
  const isError = issue.severity === "error";
  return (
    <div
      className={`flex items-start gap-2 rounded-md px-3 py-1.5 text-xs ${
        isError
          ? "bg-red-950/40 text-red-300"
          : "bg-amber-950/40 text-amber-300"
      }`}
    >
      <span className="mt-0.5 shrink-0 font-bold uppercase">
        {isError ? "Error" : "Warn"}
      </span>
      {issue.path && (
        <span className="shrink-0 font-mono text-zinc-400">{issue.path}</span>
      )}
      <span>{issue.message}</span>
    </div>
  );
}

function SchemaCard({
  schema,
  onSave,
  isSaving,
  isSaved,
}: {
  schema: SchemaValidationSummary;
  onSave: () => void;
  isSaving: boolean;
  isSaved: boolean;
}) {
  const [warningsExpanded, setWarningsExpanded] = useState(false);

  const label = schema.schemaType
    ? schema.schemaType
    : schema.parseError
    ? "Invalid JSON"
    : "Unknown";

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full shrink-0 ${statusDot(
              schema.valid,
              schema.errorCount
            )}`}
          />
          <span className="font-semibold text-white">{label}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-xs font-medium ${statusColor(
              schema.valid,
              schema.errorCount,
              schema.warningCount
            )}`}
          >
            {schema.errorCount > 0
              ? `${schema.errorCount} error${schema.errorCount > 1 ? "s" : ""}${
                  schema.warningCount > 0
                    ? ` · ${schema.warningCount} warning${
                        schema.warningCount > 1 ? "s" : ""
                      }`
                    : ""
                }`
              : schema.warningCount > 0
              ? `${schema.warningCount} warning${schema.warningCount > 1 ? "s" : ""}`
              : "Valid"}
          </span>
          {isSaved ? (
            <span className="rounded-md bg-emerald-900/40 px-2.5 py-1 text-xs font-medium text-emerald-400">
              Saved
            </span>
          ) : (
            <button
              onClick={onSave}
              disabled={isSaving}
              className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
            >
              {isSaving ? "Saving…" : "Save schema"}
            </button>
          )}
        </div>
      </div>

      {/* Errors — always expanded */}
      {schema.errors.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {schema.errors.map((e, i) => (
            <IssueRow key={i} issue={e} />
          ))}
        </div>
      )}

      {/* Warnings — collapsible */}
      {schema.warnings.length > 0 && (
        <div>
          <button
            onClick={() => setWarningsExpanded((v) => !v)}
            className="mb-1 text-xs text-amber-400 underline-offset-2 hover:underline"
          >
            {warningsExpanded ? "Hide" : "Show"} {schema.warnings.length} warning
            {schema.warnings.length > 1 ? "s" : ""}
          </button>
          {warningsExpanded && (
            <div className="flex flex-col gap-1">
              {schema.warnings.map((w, i) => (
                <IssueRow key={i} issue={w} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Valid and no warnings */}
      {schema.valid && schema.warnings.length === 0 && (
        <p className="text-xs text-emerald-400">
          No issues found. This schema is valid.
        </p>
      )}
    </div>
  );
}

function OpportunityCard({
  opp,
  onCreate,
}: {
  opp: MissingOpportunity;
  onCreate: () => void;
}) {
  const confidenceColor =
    opp.confidence === "high"
      ? "text-emerald-400"
      : opp.confidence === "medium"
      ? "text-amber-400"
      : "text-zinc-400";

  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-zinc-600" />
          <span className="font-semibold text-white">{opp.schemaType}</span>
          <span className={`text-xs font-medium ${confidenceColor}`}>
            {opp.confidence} confidence
          </span>
        </div>
        <p className="text-xs text-zinc-400">{opp.reason}</p>
      </div>
      <button
        onClick={onCreate}
        className="shrink-0 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
      >
        Create
      </button>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────

export default function ValidatorPage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<UrlScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingIndexes, setSavingIndexes] = useState<Set<number>>(new Set());
  const [savedIndexes, setSavedIndexes] = useState<Set<number>>(new Set());

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setIsLoading(true);
    setError(null);
    setResults(null);
    setSavingIndexes(new Set());
    setSavedIndexes(new Set());

    try {
      const res = await fetch("/api/validate-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Failed to scan URL");
        return;
      }

      setResults(data as UrlScanResult);
    } catch {
      setError("Network error — please try again");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSaveSchema(schema: SchemaValidationSummary, index: number) {
    if (!results) return;

    setSavingIndexes((prev) => new Set(prev).add(index));

    try {
      const name = schema.schemaType
        ? `${schema.schemaType} from ${new URL(results.finalUrl).hostname}`
        : `Schema ${index + 1} from ${new URL(results.finalUrl).hostname}`;

      const res = await fetch("/api/schemas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          schema_type: schema.schemaType ?? "Unknown",
          content: schema.parsed ?? {},
          source_url: results.finalUrl,
          validation_errors: schema.errors,
          missing_opportunities: results.missingOpportunities,
        }),
      });

      if (res.ok) {
        setSavedIndexes((prev) => new Set(prev).add(index));
      }
    } finally {
      setSavingIndexes((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  }

  function handleCreateOpportunity(schemaType: string) {
    router.push(`/editor?type=${encodeURIComponent(schemaType)}`);
  }

  const displayUrl = results?.finalUrl ?? url;
  let hostname = "";
  try {
    hostname = new URL(displayUrl).hostname;
  } catch {
    hostname = displayUrl;
  }

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">URL Validator</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Enter a URL to scan for JSON-LD schema markup and validate against
          schema.org specifications.
        </p>
      </div>

      {/* URL input */}
      <form onSubmit={handleScan} className="mb-8 flex gap-3">
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
          {isLoading ? "Scanning…" : "Scan URL"}
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
          Fetching and scanning {url}…
        </div>
      )}

      {/* Results */}
      {results && !isLoading && (
        <div>
          {/* Summary bar */}
          <div className="mb-6 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white">
                Results for{" "}
                <span className="font-mono text-zinc-300">{hostname}</span>
              </p>
              {results.fetchStatusCode > 0 && (
                <p className="mt-0.5 text-xs text-zinc-500">
                  HTTP {results.fetchStatusCode}
                  {results.url !== results.finalUrl && (
                    <> · redirected to {results.finalUrl}</>
                  )}
                </p>
              )}
            </div>
            <div className="flex gap-3 text-sm">
              <span className="text-zinc-400">
                {results.totalSchemas} schema
                {results.totalSchemas !== 1 ? "s" : ""} found
              </span>
              {results.validCount > 0 && (
                <span className="text-emerald-400">
                  {results.validCount} valid
                </span>
              )}
              {results.invalidCount > 0 && (
                <span className="text-red-400">
                  {results.invalidCount} invalid
                </span>
              )}
            </div>
          </div>

          {/* No schemas found */}
          {results.totalSchemas === 0 && (
            <div className="mb-6 rounded-xl border border-dashed border-zinc-700 p-8 text-center">
              <p className="text-zinc-500">
                No JSON-LD schema markup found on this page.
              </p>
            </div>
          )}

          {/* Schemas found */}
          {results.schemasFound.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Schemas Found
              </h2>
              <div className="flex flex-col gap-3">
                {results.schemasFound.map((schema, i) => (
                  <SchemaCard
                    key={i}
                    schema={schema}
                    onSave={() => handleSaveSchema(schema, i)}
                    isSaving={savingIndexes.has(i)}
                    isSaved={savedIndexes.has(i)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Missing opportunities */}
          {results.missingOpportunities.length > 0 && (
            <div>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Missing Opportunities
              </h2>
              <div className="flex flex-col gap-3">
                {results.missingOpportunities.map((opp, i) => (
                  <OpportunityCard
                    key={i}
                    opp={opp}
                    onCreate={() => handleCreateOpportunity(opp.schemaType)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* No opportunities */}
          {results.missingOpportunities.length === 0 &&
            results.totalSchemas > 0 && (
              <div className="rounded-xl border border-dashed border-zinc-700 p-6 text-center">
                <p className="text-sm text-zinc-500">
                  No additional schema opportunities detected for this page.
                </p>
              </div>
            )}
        </div>
      )}
    </div>
  );
}
