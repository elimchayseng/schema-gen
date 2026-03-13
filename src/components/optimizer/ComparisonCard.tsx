"use client";

import { useState } from "react";
import type { SchemaComparison, ResolvedIssue } from "@/lib/optimizer/types";
import type { ValidationResult } from "@/lib/validation/types";
import IssueRow from "@/components/IssueRow";
import { copyJsonLdScript } from "@/lib/copy-utils";
import { saveSchema } from "@/lib/save-schema";

type Tab = "current" | "fixed" | "generated";

function tabLabel(
  tab: Tab,
  comparison: SchemaComparison
): { label: string; badge: string; color: string } {
  switch (tab) {
    case "current": {
      const v = comparison.existing?.validation;
      const errCount = v?.errors.length ?? 0;
      const warnCount = v?.warnings.length ?? 0;
      const total = errCount + warnCount;
      return {
        label: "Current",
        badge: total > 0 ? `${total}` : "0",
        color:
          errCount > 0
            ? "text-red-400"
            : warnCount > 0
              ? "text-amber-400"
              : "text-emerald-400",
      };
    }
    case "fixed": {
      const resolved = comparison.fixed?.resolvedFromOriginal.length ?? 0;
      const remaining = comparison.fixed?.remainingErrors.length ?? 0;
      return {
        label: "Auto-Fixed",
        badge: resolved > 0 ? `+${resolved}` : "0",
        color: remaining > 0 ? "text-amber-400" : "text-emerald-400",
      };
    }
    case "generated": {
      const resolved = comparison.generated?.resolvedFromOriginal.length ?? 0;
      const errCount = comparison.generated?.validation.errors.length ?? 0;
      const warnCount = comparison.generated?.validation.warnings.length ?? 0;
      return {
        label: "AI Enhanced",
        badge: resolved > 0 ? `+${resolved}` : "0",
        color:
          errCount > 0
            ? "text-red-400"
            : warnCount > 0
              ? "text-amber-400"
              : "text-emerald-400",
      };
    }
  }
}

function ResolvedList({ issues }: { issues: ResolvedIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="mb-3 flex flex-col gap-1">
      {issues.map((r, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded-md bg-emerald-950/30 px-3 py-1.5 text-xs text-emerald-300"
        >
          <span className="mt-0.5 shrink-0 font-bold">&#10003;</span>
          <span>{r.description}</span>
        </div>
      ))}
    </div>
  );
}

function ValidationIssues({ validation }: { validation: ValidationResult }) {
  if (validation.errors.length === 0 && validation.warnings.length === 0) {
    return (
      <p className="mb-3 text-xs text-emerald-400">
        No issues found. This schema is valid.
      </p>
    );
  }

  return (
    <div className="mb-3 flex flex-col gap-1">
      {validation.errors.map((e, i) => (
        <IssueRow key={`e-${i}`} issue={e} />
      ))}
      {validation.warnings.map((w, i) => (
        <IssueRow key={`w-${i}`} issue={w} />
      ))}
    </div>
  );
}

function SchemaDisplay({ schema }: { schema: Record<string, unknown> }) {
  return (
    <pre className="mb-3 max-h-80 overflow-auto rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-200">
      {JSON.stringify(schema, null, 2)}
    </pre>
  );
}

/**
 * Returns the best available schema: AI Enhanced > Auto-Fixed > Original
 */
function getBestSchema(
  comparison: SchemaComparison
): Record<string, unknown> | null {
  if (comparison.generated?.jsonld) return comparison.generated.jsonld;
  if (comparison.fixed?.schema) return comparison.fixed.schema;
  return comparison.existing?.schema ?? null;
}

/**
 * Returns a label for the pipeline stage that produced the best schema.
 */
function getBestSchemaSource(comparison: SchemaComparison): string {
  if (comparison.generated?.jsonld) return "AI Enhanced";
  if (comparison.fixed?.schema) return "Auto-Fixed";
  return "Original";
}

export default function ComparisonCard({
  comparison,
  sourceUrl,
}: {
  comparison: SchemaComparison;
  sourceUrl: string;
}) {
  const availableTabs: Tab[] = [];
  if (comparison.existing) availableTabs.push("current");
  if (comparison.fixed) availableTabs.push("fixed");
  if (comparison.generated) availableTabs.push("generated");

  // Default to AI Enhanced if available, else the last available tab
  const defaultTab = availableTabs.includes("generated")
    ? "generated"
    : availableTabs[availableTabs.length - 1] ?? "current";

  const [activeTab, setActiveTab] = useState<Tab>(defaultTab);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const bestSchema = getBestSchema(comparison);

  async function handleCopy() {
    if (!bestSchema) return;
    const ok = await copyJsonLdScript(JSON.stringify(bestSchema, null, 2));
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  }

  async function handleSave() {
    if (!bestSchema) return;

    setSaving(true);
    try {
      let hostname = "";
      try {
        hostname = new URL(sourceUrl).hostname;
      } catch {
        hostname = sourceUrl;
      }

      const result = await saveSchema({
        name: `${comparison.schemaType} from ${hostname}`,
        schema_type: comparison.schemaType,
        content: bestSchema,
        source_url: sourceUrl,
      });

      if (result.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  const generated = comparison.generated;

  const schemaSource = getBestSchemaSource(comparison);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-white">
            {comparison.schemaType}
          </span>
          {generated && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                generated.priority === 1
                  ? "bg-emerald-900/40 text-emerald-400"
                  : generated.priority === 2
                    ? "bg-amber-900/40 text-amber-400"
                    : "bg-zinc-800 text-zinc-400"
              }`}
            >
              {generated.priority === 1
                ? "Primary"
                : generated.priority === 2
                  ? "Recommended"
                  : "Optional"}
            </span>
          )}
        </div>
      </div>

      {/* Optimized Schema — hero section */}
      {bestSchema && (
        <div className="p-5">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">
                Optimized Schema
              </span>
              <span className="rounded-full bg-indigo-900/40 px-2 py-0.5 text-[10px] font-semibold text-indigo-300">
                {schemaSource}
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
          <SchemaDisplay schema={bestSchema} />
        </div>
      )}

      {/* Collapsible details section */}
      <div className="border-t border-zinc-800">
        <button
          onClick={() => setDetailsOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-5 py-3 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          <svg
            className={`h-3 w-3 transition-transform ${detailsOpen ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          Details — what changed
        </button>

        {detailsOpen && (
          <>
            {/* Tabs */}
            <div className="flex border-b border-zinc-800">
              {availableTabs.map((tab) => {
                const info = tabLabel(tab, comparison);
                const isActive = activeTab === tab;
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors ${
                      isActive
                        ? "border-b-2 border-indigo-500 text-white"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <span>{info.label}</span>
                    <span className={`font-mono text-[10px] ${info.color}`}>
                      {info.badge}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Tab content */}
            <div className="p-5">
              {activeTab === "current" && comparison.existing && (
                <ValidationIssues validation={comparison.existing.validation} />
              )}

              {activeTab === "fixed" && comparison.fixed && (
                <>
                  <ResolvedList issues={comparison.fixed.resolvedFromOriginal} />
                  {comparison.fixed.remainingErrors.length > 0 && (
                    <div className="mb-3 flex flex-col gap-1">
                      {comparison.fixed.remainingErrors.map((e, i) => (
                        <IssueRow key={i} issue={e} />
                      ))}
                    </div>
                  )}
                  {comparison.fixed.resolvedFromOriginal.length > 0 &&
                    comparison.fixed.remainingErrors.length === 0 && (
                      <p className="mb-3 text-xs text-emerald-400">
                        All issues resolved by auto-fixer.
                      </p>
                    )}
                </>
              )}

              {activeTab === "generated" && comparison.generated && (
                <>
                  <ResolvedList
                    issues={comparison.generated.resolvedFromOriginal}
                  />
                  <ValidationIssues validation={comparison.generated.validation} />

                  {comparison.generated.rationale && (
                    <p className="mb-3 text-sm text-zinc-400">
                      {comparison.generated.rationale}
                    </p>
                  )}

                  {comparison.generated.shopifyInstructions && (
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
                          {comparison.generated.shopifyInstructions}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
