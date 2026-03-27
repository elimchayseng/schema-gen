"use client";

import { useState } from "react";
import type { SchemaComparison, ResolvedIssue } from "@/lib/optimizer/types";
import type { ValidationResult, ValidationIssue } from "@/lib/validation/types";
import { getSeverityContext } from "@/lib/validation/rich-results";

type Tab = "current" | "fixed" | "generated";

function tabInfo(
  tab: Tab,
  comparison: SchemaComparison
): { label: string; count: string; color: string } {
  switch (tab) {
    case "current": {
      const v = comparison.existing?.validation;
      const total = (v?.errors.length ?? 0) + (v?.warnings.length ?? 0);
      return {
        label: "Current",
        count: `${total}`,
        color:
          (v?.errors.length ?? 0) > 0
            ? "text-error"
            : (v?.warnings.length ?? 0) > 0
              ? "text-warn"
              : "text-valid",
      };
    }
    case "fixed": {
      const resolved = comparison.fixed?.resolvedFromOriginal.length ?? 0;
      const remaining = comparison.fixed?.remainingErrors.length ?? 0;
      return {
        label: "Auto-Fixed",
        count: resolved > 0 ? `+${resolved}` : "0",
        color: remaining > 0 ? "text-warn" : "text-valid",
      };
    }
    case "generated": {
      const resolved = comparison.generated?.resolvedFromOriginal.length ?? 0;
      const errCount = comparison.generated?.validation.errors.length ?? 0;
      const hasNotes = (comparison.generated?.enhancementNotes?.length ?? 0) > 0;
      return {
        label: "AI Enhanced",
        count: resolved > 0 ? `+${resolved}` : hasNotes ? "notes" : "0",
        color: errCount > 0 ? "text-error" : "text-valid",
      };
    }
  }
}

export function IssueItem({ issue, isError, isTip }: { issue: ValidationIssue; isError: boolean; isTip?: boolean }) {
  const context = getSeverityContext(issue.code);
  return (
    <div
      className={`flex items-start gap-2 rounded-sm px-3 py-1.5 text-xs ${
        isError ? "bg-error-dim/30" : "bg-warn-dim/30"
      }`}
    >
      <span className={`shrink-0 font-mono font-bold ${isError ? "text-error" : isTip ? "text-text-muted" : "text-warn"}`}>
        {isError ? "ERR" : isTip ? "TIP" : "WRN"}
      </span>
      <span className="text-text-secondary">
        <span className="font-mono text-text-muted">{issue.path}</span>{" "}
        {issue.message}
        {context && (
          <span
            className={`ml-1.5 inline-block rounded-sm px-1 py-0.5 text-[10px] font-medium ${
              context.impact === "critical"
                ? "bg-error/10 text-error"
                : context.impact === "recommended"
                  ? "bg-warn/10 text-warn"
                  : "bg-surface-3 text-text-muted"
            }`}
          >
            {context.label}
          </span>
        )}
      </span>
    </div>
  );
}

export function IssueList({ validation, isTip }: { validation: ValidationResult; isTip?: boolean }) {
  if (validation.errors.length === 0 && validation.warnings.length === 0) {
    return <p className="text-xs text-valid">No issues found.</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      {validation.errors.map((e, i) => (
        <IssueItem key={`e-${i}`} issue={e} isError />
      ))}
      {validation.warnings.map((w, i) => (
        <IssueItem key={`w-${i}`} issue={w} isError={false} isTip={isTip} />
      ))}
    </div>
  );
}

function ResolvedList({ issues }: { issues: ResolvedIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 mb-2">
      {issues.map((r, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded-sm bg-valid-dim/30 px-3 py-1.5 text-xs"
        >
          <span className="shrink-0 font-mono text-valid">FIX</span>
          <span className="text-text-secondary">{r.description}</span>
        </div>
      ))}
    </div>
  );
}

export default function SchemaDetail({
  comparison,
}: {
  comparison: SchemaComparison;
}) {
  const availableTabs: Tab[] = [];
  if (comparison.existing) availableTabs.push("current");
  if (comparison.fixed) availableTabs.push("fixed");
  if (comparison.generated) availableTabs.push("generated");

  const defaultTab = availableTabs.includes("generated")
    ? "generated"
    : availableTabs[availableTabs.length - 1] ?? "current";

  const [activeTab, setActiveTab] = useState<Tab>(defaultTab);

  if (availableTabs.length === 0) return null;

  return (
    <div className="rounded-md border border-border overflow-hidden">
      {/* Tabs */}
      <div className="flex border-b border-border bg-surface-2/50">
        {availableTabs.map((tab) => {
          const info = tabInfo(tab, comparison);
          const isActive = activeTab === tab;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors ${
                isActive
                  ? "border-b-2 border-accent text-text-primary bg-surface-1"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              <span>{info.label}</span>
              <span className={`font-mono text-[10px] ${info.color}`}>
                {info.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="p-4">
        {activeTab === "current" && comparison.existing && (
          <IssueList validation={comparison.existing.validation} />
        )}

        {activeTab === "fixed" && comparison.fixed && (
          <>
            <ResolvedList issues={comparison.fixed.resolvedFromOriginal} />
            {comparison.fixed.remainingErrors.length > 0 && (
              <div className="flex flex-col gap-1">
                {comparison.fixed.remainingErrors.map((e, i) => (
                  <IssueItem key={i} issue={e} isError />
                ))}
              </div>
            )}
            {comparison.fixed.resolvedFromOriginal.length > 0 &&
              comparison.fixed.remainingErrors.length === 0 && (
                <p className="text-xs text-valid">All issues resolved by auto-fixer.</p>
              )}
          </>
        )}

        {activeTab === "generated" && comparison.generated && (
          <>
            {comparison.generated.rationale && (
              <div className="mb-3 rounded-md border border-accent/20 bg-accent/5 px-3 py-2">
                <p className="text-xs font-medium text-accent mb-0.5">Why this schema</p>
                <p className="text-xs text-text-secondary leading-relaxed">
                  {comparison.generated.rationale}
                </p>
              </div>
            )}
            <ResolvedList issues={comparison.generated.resolvedFromOriginal} />
            {/* If enhancement notes exist, only show errors (notes shown outside this panel) */}
            {comparison.generated.enhancementNotes?.length ? (
              <>
                {comparison.generated.validation.errors.length > 0 && (
                  <IssueList
                    validation={{
                      ...comparison.generated.validation,
                      warnings: [],
                    }}
                  />
                )}
                {comparison.generated.validation.errors.length === 0 && (
                  <p className="text-xs text-valid">No issues found.</p>
                )}
              </>
            ) : (
              <IssueList validation={comparison.generated.validation} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
