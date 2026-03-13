"use client";

import { useState, useCallback, useEffect } from "react";
import type { GenerateResponse, ValidatedRecommendation } from "@/lib/ai/types";
import type { ValidationResult, FixApplied } from "@/lib/validation/types";
import IssueRow from "@/components/IssueRow";
import { copyJsonLdScript, copyMergedJsonLdScript } from "@/lib/copy-utils";
import { saveSchema } from "@/lib/save-schema";

// ─── Helpers ────────────────────────────────────────────────────────────────

function priorityLabel(p: 1 | 2 | 3) {
  if (p === 1) return "Primary";
  if (p === 2) return "Recommended";
  return "Optional";
}

function priorityColor(p: 1 | 2 | 3) {
  if (p === 1) return "bg-emerald-900/40 text-emerald-400";
  if (p === 2) return "bg-amber-900/40 text-amber-400";
  return "bg-zinc-800 text-zinc-400";
}

function statusColor(result: ValidationResult) {
  if (result.errors.length > 0) return "text-red-400";
  if (result.warnings.length > 0) return "text-amber-400";
  return "text-emerald-400";
}

function statusText(result: ValidationResult) {
  if (result.errors.length > 0) {
    let text = `${result.errors.length} error${result.errors.length > 1 ? "s" : ""}`;
    if (result.warnings.length > 0)
      text += ` · ${result.warnings.length} warning${result.warnings.length > 1 ? "s" : ""}`;
    return text;
  }
  if (result.warnings.length > 0)
    return `${result.warnings.length} warning${result.warnings.length > 1 ? "s" : ""}`;
  return "Valid";
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function FixBanner({ fixes }: { fixes: FixApplied[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mb-3 rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-3 py-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-xs font-medium text-emerald-400"
      >
        <span>
          Auto-fixed {fixes.length} issue{fixes.length > 1 ? "s" : ""}
        </span>
        <span className="text-emerald-600">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <ul className="mt-2 flex flex-col gap-1">
          {fixes.map((fix, i) => (
            <li key={i} className="text-xs text-emerald-300/80">
              <span className="font-mono text-zinc-500">{fix.path}</span>{" "}
              {fix.description}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RecommendationCard({
  rec,
  index,
  onJsonChange,
  onSave,
  isSaving,
  isSaved,
  liveValidation,
}: {
  rec: ValidatedRecommendation;
  index: number;
  onJsonChange: (index: number, value: string) => void;
  onSave: () => void;
  isSaving: boolean;
  isSaved: boolean;
  liveValidation: ValidationResult | null;
}) {
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const [warningsExpanded, setWarningsExpanded] = useState(false);
  const [jsonText, setJsonText] = useState(
    JSON.stringify(rec.jsonld, null, 2)
  );
  const [copied, setCopied] = useState(false);

  const validation = liveValidation ?? rec.validation;

  function handleJsonEdit(value: string) {
    setJsonText(value);
    onJsonChange(index, value);
  }

  async function handleCopy() {
    const ok = await copyJsonLdScript(jsonText);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-white">{rec.type}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${priorityColor(
              rec.priority
            )}`}
          >
            {priorityLabel(rec.priority)}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs font-medium ${statusColor(validation)}`}>
            {statusText(validation)}
          </span>
        </div>
      </div>

      {/* Rationale */}
      <p className="mb-3 text-sm text-zinc-400">{rec.rationale}</p>

      {/* Auto-fix banner */}
      {rec.fixes && rec.fixes.length > 0 && (
        <FixBanner fixes={rec.fixes} />
      )}

      {/* Editable JSON textarea */}
      <textarea
        value={jsonText}
        onChange={(e) => handleJsonEdit(e.target.value)}
        spellCheck={false}
        className="mb-3 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
        rows={Math.min(20, jsonText.split("\n").length + 2)}
      />

      {/* Validation issues */}
      {validation.errors.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {validation.errors.map((e, i) => (
            <IssueRow key={i} issue={e} />
          ))}
        </div>
      )}
      {validation.warnings.length > 0 && (
        <div className="mb-3">
          <button
            onClick={() => setWarningsExpanded((v) => !v)}
            className="mb-1 text-xs text-amber-400 underline-offset-2 hover:underline"
          >
            {warningsExpanded ? "Hide" : "Show"} {validation.warnings.length}{" "}
            warning{validation.warnings.length > 1 ? "s" : ""}
          </button>
          {warningsExpanded && (
            <div className="flex flex-col gap-1">
              {validation.warnings.map((w, i) => (
                <IssueRow key={i} issue={w} />
              ))}
            </div>
          )}
        </div>
      )}

      {validation.valid && validation.warnings.length === 0 && (
        <p className="mb-3 text-xs text-emerald-400">
          No issues found. This schema is valid.
        </p>
      )}

      {/* Shopify instructions */}
      <div className="mb-3">
        <button
          onClick={() => setInstructionsExpanded((v) => !v)}
          className="text-xs text-indigo-400 underline-offset-2 hover:underline"
        >
          {instructionsExpanded ? "Hide" : "Show"} Shopify placement instructions
        </button>
        {instructionsExpanded && (
          <div className="mt-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-300">
            {rec.shopifyInstructions}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleCopy}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
        {isSaved ? (
          <span className="rounded-md bg-emerald-900/40 px-3 py-1.5 text-xs font-medium text-emerald-400">
            Saved
          </span>
        ) : (
          <button
            onClick={onSave}
            disabled={isSaving}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
          >
            {isSaving ? "Saving…" : "Save to Dashboard"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function GeneratorPage() {
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<GenerateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingIndexes, setSavingIndexes] = useState<Set<number>>(new Set());
  const [savedIndexes, setSavedIndexes] = useState<Set<number>>(new Set());
  const [liveValidations, setLiveValidations] = useState<
    Map<number, ValidationResult>
  >(new Map());
  const [editedJsons, setEditedJsons] = useState<Map<number, string>>(
    new Map()
  );
  const [copiedAll, setCopiedAll] = useState(false);

  // Debounced live validation
  const [debounceTimers] = useState<Map<number, NodeJS.Timeout>>(new Map());

  useEffect(() => {
    return () => {
      for (const t of debounceTimers.values()) clearTimeout(t);
    };
  }, [debounceTimers]);

  const handleJsonChange = useCallback(
    (index: number, value: string) => {
      setEditedJsons((prev) => new Map(prev).set(index, value));

      // Clear existing timer
      const existing = debounceTimers.get(index);
      if (existing) clearTimeout(existing);

      // Debounce validation at 300ms
      const timer = setTimeout(async () => {
        try {
          // Validate by calling the validation engine client-side
          // We parse to check JSON validity first
          JSON.parse(value);
          const { validateEditorContent } = await import(
            "@/lib/validation/integration"
          );
          const result = validateEditorContent(value);
          setLiveValidations((prev) => new Map(prev).set(index, result));
        } catch {
          // If JSON is invalid, show a parse error
          setLiveValidations((prev) =>
            new Map(prev).set(index, {
              valid: false,
              errors: [
                {
                  severity: "error",
                  path: "",
                  message: "Invalid JSON syntax",
                  code: "INVALID_JSON",
                },
              ],
              warnings: [],
              summary: {
                errorCount: 1,
                warningCount: 0,
                schemaType: null,
                validationTimeMs: 0,
              },
            })
          );
        }
      }, 300);
      debounceTimers.set(index, timer);
    },
    [debounceTimers]
  );

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setIsLoading(true);
    setError(null);
    setResults(null);
    setSavingIndexes(new Set());
    setSavedIndexes(new Set());
    setLiveValidations(new Map());
    setEditedJsons(new Map());

    try {
      const res = await fetch("/api/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Failed to generate schemas");
        return;
      }

      setResults(data as GenerateResponse);
    } catch {
      setError("Network error — please try again");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave(rec: ValidatedRecommendation, index: number) {
    if (!results) return;

    setSavingIndexes((prev) => new Set(prev).add(index));

    try {
      let hostname = "";
      try {
        hostname = new URL(url).hostname;
      } catch {
        hostname = url;
      }

      // Use edited JSON if available, otherwise original
      const editedJson = editedJsons.get(index);
      let content = rec.jsonld;
      if (editedJson) {
        try {
          content = JSON.parse(editedJson);
        } catch {
          // Fall back to original if edited JSON is invalid
        }
      }

      const result = await saveSchema({
        name: `${rec.type} from ${hostname}`,
        schema_type: rec.type,
        content,
        source_url: url.trim(),
      });

      if (result.ok) {
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

  async function handleCopyAll() {
    if (!results) return;

    const jsonlds = results.recommendations.map((rec, i) => {
      const edited = editedJsons.get(i);
      if (edited) {
        try {
          return JSON.parse(edited);
        } catch {
          return rec.jsonld;
        }
      }
      return rec.jsonld;
    });

    const ok = await copyMergedJsonLdScript(jsonlds);
    setCopiedAll(ok);
    if (ok) setTimeout(() => setCopiedAll(false), 2000);
  }

  // Sort recommendations by priority
  const sortedRecs = results
    ? [...results.recommendations].sort((a, b) => a.priority - b.priority)
    : [];

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Schema Generator</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Enter a URL to generate AI-powered JSON-LD schema recommendations with
          Shopify placement instructions.
        </p>
      </div>

      {/* URL input */}
      <form onSubmit={handleGenerate} className="mb-8 flex gap-3">
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
          {isLoading ? "Generating…" : "Generate"}
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
          Analyzing page and generating schemas…
        </div>
      )}

      {/* Results */}
      {results && !isLoading && (
        <div>
          {/* Page type badge */}
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">
                Detected page type:
              </span>
              <span className="rounded-full bg-zinc-800 px-3 py-0.5 text-xs font-medium text-zinc-300">
                {results.pageType}
              </span>
            </div>
            <span className="text-sm text-zinc-400">
              {results.recommendations.length} schema
              {results.recommendations.length !== 1 ? "s" : ""} recommended
            </span>
          </div>

          {/* Empty state */}
          {sortedRecs.length === 0 && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-8 text-center">
              <p className="text-sm text-zinc-400">
                No schema recommendations found for this page. Try a different URL
                or a page with more structured content.
              </p>
            </div>
          )}

          {/* Recommendation cards */}
          {sortedRecs.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Recommendations
              </h2>
              <div className="flex flex-col gap-4">
                {sortedRecs.map((rec, i) => {
                  // Find original index for state tracking
                  const origIndex = results.recommendations.indexOf(rec);
                  return (
                    <RecommendationCard
                      key={origIndex}
                      rec={rec}
                      index={origIndex}
                      onJsonChange={handleJsonChange}
                      onSave={() => handleSave(rec, origIndex)}
                      isSaving={savingIndexes.has(origIndex)}
                      isSaved={savedIndexes.has(origIndex)}
                      liveValidation={liveValidations.get(origIndex) ?? null}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* Copy All merged JSON-LD */}
          {results.recommendations.length > 0 && (
            <div className="mb-8 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white">
                    Merged JSON-LD
                  </h3>
                  <p className="mt-0.5 text-xs text-zinc-400">
                    All schemas combined in a single script tag, ready to paste
                    into your Shopify theme.
                  </p>
                </div>
                <button
                  onClick={handleCopyAll}
                  className="rounded-md bg-indigo-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-indigo-500"
                >
                  {copiedAll ? "Copied!" : "Copy All"}
                </button>
              </div>
            </div>
          )}

          {/* Notes */}
          {results.notes.length > 0 && (
            <div>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Notes
              </h2>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                <ul className="flex flex-col gap-2">
                  {results.notes.map((note, i) => (
                    <li key={i} className="text-sm text-zinc-400">
                      {note}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
