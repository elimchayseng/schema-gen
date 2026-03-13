import type { ValidationIssue } from "@/lib/validation/types";

export default function IssueRow({ issue }: { issue: ValidationIssue }) {
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
