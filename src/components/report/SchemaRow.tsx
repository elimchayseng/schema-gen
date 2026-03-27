"use client";

import { useState } from "react";
import type { SchemaComparison } from "@/lib/optimizer/types";
import type { ValidatedRecommendation } from "@/lib/ai/types";
import SchemaDetail, { IssueList } from "./SchemaDetail";
import { copyJsonLdScript } from "@/lib/copy-utils";
import { saveSchema } from "@/lib/save-schema";
import { getRichResultInfo } from "@/lib/validation/rich-results";

interface SchemaRowProps {
  comparison?: SchemaComparison;
  recommendation?: ValidatedRecommendation;
  sourceUrl: string;
  isNew?: boolean;
}

function getBestSchema(comparison: SchemaComparison): Record<string, unknown> | null {
  if (comparison.generated?.jsonld) return comparison.generated.jsonld;
  if (comparison.fixed?.schema) return comparison.fixed.schema;
  return comparison.existing?.schema ?? null;
}

function getSourceLabel(comparison: SchemaComparison): string {
  if (comparison.generated?.jsonld) return "AI Enhanced";
  if (comparison.fixed?.schema) return "Auto-Fixed";
  return "Original";
}

function getStatus(comparison: SchemaComparison): "valid" | "warning" | "error" {
  const best = comparison.generated ?? comparison.fixed ?? comparison.existing;
  if (!best) return "error";
  const v = "validation" in best ? best.validation : null;
  if (!v) return "error";
  if (v.errors.length > 0) return "error";
  // No errors = valid. Warnings are enhancement suggestions, not blockers.
  return "valid";
}

function getRecStatus(rec: ValidatedRecommendation): "valid" | "warning" | "error" {
  if (rec.validation.errors.length > 0) return "error";
  // No errors = valid. Warnings are enhancement suggestions, not blockers.
  return "valid";
}

const statusDot = {
  valid: "bg-valid",
  warning: "bg-warn",
  error: "bg-error",
} as const;


export default function SchemaRow({
  comparison,
  recommendation,
  sourceUrl,
  isNew = false,
}: SchemaRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const schemaType = comparison?.schemaType ?? recommendation?.type ?? "Unknown";
  const status = comparison ? getStatus(comparison) : getRecStatus(recommendation!);
  const bestSchema = comparison
    ? getBestSchema(comparison)
    : recommendation?.jsonld ?? null;
  const sourceTag = comparison ? getSourceLabel(comparison) : "AI Generated";
  const shopifyInstructions =
    comparison?.generated?.shopifyInstructions ??
    recommendation?.shopifyInstructions ??
    null;

  const richResult = getRichResultInfo(schemaType);

  // For AI-refined schemas, only count errors (warnings are captured in enhancementNotes)
  const enhancementNotes =
    comparison?.generated?.enhancementNotes ??
    recommendation?.enhancementNotes ??
    [];
  const hasEnhancementNotes = enhancementNotes.length > 0;

  // Only count actual errors as "issues". Warnings are enhancement suggestions, not blockers.
  const issueCount = comparison
    ? (() => {
        const best = comparison.generated ?? comparison.fixed ?? comparison.existing;
        if (!best) return 0;
        const v = "validation" in best ? best.validation : null;
        return v?.errors.length ?? 0;
      })()
    : (recommendation?.validation.errors.length ?? 0);

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    if (!bestSchema) return;
    const ok = await copyJsonLdScript(JSON.stringify(bestSchema, null, 2));
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  }

  async function handleSave(e: React.MouseEvent) {
    e.stopPropagation();
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
        name: `${schemaType} from ${hostname}`,
        schema_type: schemaType,
        content: bestSchema,
        source_url: sourceUrl,
      });
      if (result.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Row header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-2/50"
      >
        {/* Expand chevron */}
        <svg
          className={`h-3 w-3 shrink-0 text-text-muted transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>

        {/* Status dot */}
        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot[status]}`} />

        {/* Schema type */}
        <span className="font-medium text-sm text-text-primary">{schemaType}</span>

        {/* Badges */}
        {isNew && (
          <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent">
            New
          </span>
        )}
        <span className="rounded-sm bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
          {sourceTag}
        </span>
        {richResult?.eligible && (
          <span
            className="rounded-sm bg-valid/10 px-1.5 py-0.5 text-[10px] font-medium text-valid"
            title={richResult.description}
          >
            Rich Result
          </span>
        )}

        {/* Spacer */}
        <span className="flex-1" />

        {/* Status indicator */}
        {issueCount > 0 && (
          <span className="text-xs font-mono text-error">
            {issueCount} issue{issueCount !== 1 ? "s" : ""}
          </span>
        )}
        {issueCount === 0 && (
          <span className="text-xs font-mono text-valid">Valid</span>
        )}

        {/* Quick actions */}
        <span
          onClick={handleCopy}
          className="rounded-md border border-border-bright px-2 py-0.5 text-[10px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
        >
          {copied ? "Copied!" : "Copy"}
        </span>
        {saved ? (
          <span className="text-[10px] font-medium text-valid">Saved</span>
        ) : (
          <span
            onClick={handleSave}
            className="rounded-md bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/25"
          >
            {saving ? "..." : "Save"}
          </span>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-5 pb-5">
          {/* JSON preview */}
          {bestSchema && (
            <pre className="mb-4 max-h-72 overflow-auto rounded-md bg-surface-0 p-4 font-mono text-xs leading-relaxed text-text-primary">
              {JSON.stringify(bestSchema, null, 2)}
            </pre>
          )}

          {/* Shopify placement instructions */}
          {shopifyInstructions && (
            <div className="mb-4 rounded-md border border-border bg-surface-2 px-4 py-3">
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-text-muted">
                Shopify Placement
              </h4>
              <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
                {shopifyInstructions}
              </p>
            </div>
          )}

          {/* Comparison details (for existing schemas) */}
          {comparison && <SchemaDetail comparison={comparison} />}

          {/* Recommendation details */}
          {recommendation && (
            <div>
              {recommendation.rationale && (
                <p className="text-sm text-text-secondary mb-2">
                  {recommendation.rationale}
                </p>
              )}
              {/* Only show errors as issue badges; warnings are in enhancementNotes */}
              {recommendation.enhancementNotes?.length ? (
                <>
                  {recommendation.validation.errors.length > 0 && (
                    <IssueList
                      validation={{
                        ...recommendation.validation,
                        warnings: [],
                      }}
                    />
                  )}
                </>
              ) : (
                <IssueList validation={recommendation.validation} isTip={recommendation.validation.errors.length === 0} />
              )}
            </div>
          )}

          {/* Enhancement notes — friendly guidance for remaining gaps */}
          {hasEnhancementNotes && (
            <div className="mt-4 rounded-md border border-accent/20 bg-accent/5 px-4 py-3">
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-accent">
                Enhancement Suggestions
              </h4>
              <ul className="flex flex-col gap-2">
                {enhancementNotes.map((note, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-text-secondary leading-relaxed">
                    <span className="mt-0.5 shrink-0 text-accent">&#8226;</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
