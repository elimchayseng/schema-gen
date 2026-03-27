import type { ValidationIssue } from "@/lib/validation/types";

export default function IssueRow({ issue }: { issue: ValidationIssue }) {
  const isError = issue.severity === "error";
  return (
    <div
      className={`flex items-start gap-2 rounded-sm px-3 py-1.5 text-xs ${
        isError
          ? "bg-error-dim/30 text-text-secondary"
          : "bg-warn-dim/30 text-text-secondary"
      }`}
    >
      <span
        className={`shrink-0 font-mono font-bold ${
          isError ? "text-error" : "text-warn"
        }`}
      >
        {isError ? "ERR" : "WRN"}
      </span>
      {issue.path && (
        <span className="shrink-0 font-mono text-text-muted">{issue.path}</span>
      )}
      <span>{issue.message}</span>
    </div>
  );
}
