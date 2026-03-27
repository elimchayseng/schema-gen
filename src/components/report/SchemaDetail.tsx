"use client";

import { useState } from "react";
import type { SchemaComparison, ResolvedIssue } from "@/lib/optimizer/types";
import type { ValidationResult } from "@/lib/validation/types";

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
      return {
        label: "AI Enhanced",
        count: resolved > 0 ? `+${resolved}` : "0",
        color: errCount > 0 ? "text-error" : "text-valid",
      };
    }
  }
}

function IssueList({ validation }: { validation: ValidationResult }) {
  if (validation.errors.length === 0 && validation.warnings.length === 0) {
    return <p className="text-xs text-valid">No issues found.</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      {validation.errors.map((e, i) => (
        <div
          key={`e-${i}`}
          className="flex items-start gap-2 rounded-sm bg-error-dim/30 px-3 py-1.5 text-xs"
        >
          <span className="shrink-0 font-mono text-error">ERR</span>
          <span className="text-text-secondary">
            <span className="font-mono text-text-muted">{e.path}</span>{" "}
            {e.message}
          </span>
        </div>
      ))}
      {validation.warnings.map((w, i) => (
        <div
          key={`w-${i}`}
          className="flex items-start gap-2 rounded-sm bg-warn-dim/30 px-3 py-1.5 text-xs"
        >
          <span className="shrink-0 font-mono text-warn">WRN</span>
          <span className="text-text-secondary">
            <span className="font-mono text-text-muted">{w.path}</span>{" "}
            {w.message}
          </span>
        </div>
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
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded-sm bg-error-dim/30 px-3 py-1.5 text-xs"
                  >
                    <span className="shrink-0 font-mono text-error">ERR</span>
                    <span className="text-text-secondary">{e.message}</span>
                  </div>
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
            <ResolvedList issues={comparison.generated.resolvedFromOriginal} />
            <IssueList validation={comparison.generated.validation} />
            {comparison.generated.rationale && (
              <p className="mt-2 text-xs text-text-secondary">
                {comparison.generated.rationale}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
