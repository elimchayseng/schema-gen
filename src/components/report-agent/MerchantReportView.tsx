"use client";

import { useState } from "react";
import type { MerchantReport, ReportGate, ReportPage } from "@/lib/agent/report";

/**
 * Merchant-readable run report (issue #30). Card-based, plain English, matching
 * the dashboard motif: indigo for AI/fix work, green for verified/good, amber
 * ONLY for genuine warnings (required actions), red for failures. Two proof
 * labels are kept visually distinct everywhere: our deterministic verdict
 * ("Validated by SchemaGen") vs the per-page "Confirm with Google" deep link.
 */
export default function MerchantReportView({
  report,
  backHref,
}: {
  report: MerchantReport;
  backHref: string;
}) {
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-4xl">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <a href={backHref} className="text-xs text-text-muted hover:text-text-secondary">
          &larr; Back
        </a>
        <h1 className="font-serif text-lg text-text-primary">Agent Run Report</h1>
        {report.siteDomain && (
          <span className="rounded-sm bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-text-secondary">
            {report.siteDomain}
          </span>
        )}
        <span className="ml-auto text-[11px] text-text-muted">
          {formatWhen(report.startedAt)}
        </span>
      </div>

      <VerdictBanner report={report} />

      <SummaryCards summary={report.summary} />

      {report.requiredMerchantActions.length > 0 && (
        <RequiredActionsCard actions={report.requiredMerchantActions} />
      )}

      {/* Per-page results */}
      {report.pages.length > 0 && (
        <>
          <div className="mb-2 flex items-center justify-between pl-1">
            <span className="font-serif text-[11px] uppercase tracking-wider text-text-muted">
              Pages ({report.pages.length})
            </span>
            <span className="text-[10px] text-text-muted">{report.proof.schemaGenLabel}</span>
          </div>
          <div className="mb-5 overflow-hidden rounded-lg border border-border">
            {report.pages.map((page) => (
              <PageRow
                key={page.url}
                page={page}
                googleLabel={report.proof.googleLabel}
                expanded={expandedUrl === page.url}
                onToggle={() =>
                  setExpandedUrl(expandedUrl === page.url ? null : page.url)
                }
              />
            ))}
          </div>
        </>
      )}

      {/* Proof footnote */}
      <div className="mb-8 rounded-lg border border-border bg-surface-card px-5 py-3 text-[11px] text-text-muted">
        Verdicts above are <span className="text-text-secondary">{report.proof.schemaGenLabel}</span>.
        Google offers no public API for its Rich Results Test, so each page links out —{" "}
        <span className="text-text-secondary">&ldquo;{report.proof.googleLabel}&rdquo;</span> — to
        independently confirm the result on google.com.
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function VerdictBanner({ report }: { report: MerchantReport }) {
  const { verdict } = report;
  const good = verdict.goodToGo;

  return (
    <div
      className={`mb-5 overflow-hidden rounded-lg border bg-surface-1 ${good ? "border-valid/30" : "border-warn/30"}`}
    >
      <div className="flex items-center gap-3 px-6 py-5">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-full text-xl ${good ? "bg-valid/10 text-valid" : "bg-warn/10 text-warn"}`}
        >
          {good ? "✓" : "!"}
        </div>
        <div>
          <h2 className="font-serif text-xl text-text-primary">{verdict.headline}</h2>
          <p className="text-xs text-text-secondary">{verdict.reason}</p>
        </div>
      </div>
      <div className="border-t border-border bg-surface-card px-6 py-2.5 text-[11px] text-text-muted">
        {report.proof.schemaGenLabel}
        {report.endedAt && (
          <>
            {" · "}Finished <span className="text-text-secondary">{formatWhen(report.endedAt)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryCards({ summary }: { summary: MerchantReport["summary"] }) {
  const cells: { num: number; label: string; color: string }[] = [
    { num: summary.pagesChecked, label: "Checked", color: "text-text-primary" },
    { num: summary.alreadyGood, label: "Already Good", color: "text-valid" },
    { num: summary.fixed, label: "Fixed", color: "text-fix-bright" },
    { num: summary.generated, label: "Generated", color: "text-fix-bright" },
    { num: summary.failed, label: "Failed", color: summary.failed > 0 ? "text-error" : "text-text-muted" },
    { num: summary.notReached, label: "Not Reached", color: "text-text-muted" },
  ];
  return (
    <div className="mb-5 flex items-center overflow-hidden rounded-lg border border-border bg-surface-1">
      {cells.map((c, i) => (
        <div
          key={c.label}
          className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-3 ${i < cells.length - 1 ? "border-r border-border" : ""}`}
        >
          <span className={`font-mono text-base font-bold ${c.color}`}>{c.num}</span>
          <span className="text-[10px] uppercase tracking-wider text-text-muted">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

function RequiredActionsCard({ actions }: { actions: string[] }) {
  return (
    <div className="mb-5 overflow-hidden rounded-lg border border-warn/30 bg-surface-1">
      <div className="flex items-center gap-2.5 px-5 pt-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-warn/10 text-sm text-warn">
          !
        </div>
        <h3 className="font-serif text-[15px] text-text-primary">
          Required actions ({actions.length})
        </h3>
      </div>
      <ul className="px-5 pb-4 pt-2">
        {actions.map((a, i) => (
          <li key={i} className="flex gap-2 py-1.5 text-xs text-text-secondary">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
            {a}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PageRow({
  page,
  googleLabel,
  expanded,
  onToggle,
}: {
  page: ReportPage;
  googleLabel: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const failed = page.disposition === "failed" || page.disposition === "rolled_back";

  return (
    <div className={page.disposition === "skipped" ? "opacity-50" : ""}>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 border-b border-surface-2 px-5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface-1"
      >
        <span
          className={`flex-1 truncate font-mono text-xs ${failed ? "text-error" : "text-text-primary"}`}
        >
          {urlPath(page.url)}
        </span>
        {page.schemaTypes.length > 0 && (
          <span className="hidden text-[10px] text-text-muted sm:inline">
            {page.schemaTypes.join(", ")}
          </span>
        )}
        <GateDots gates={page.gates} />
        <DispositionBadge disposition={page.disposition} />
        <span className="text-[10px] text-text-muted">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="border-b border-surface-2 bg-surface-1 px-5 pb-4 pt-3">
          {page.note && (
            <div className="mb-3 rounded-md border border-fix/25 bg-fix/[0.06] px-3 py-2 text-xs text-text-secondary">
              {page.note}
            </div>
          )}
          {page.failureReason && (
            <div className="mb-3 rounded-md border border-error/30 bg-error-dim/20 px-3 py-2 text-xs text-error">
              {page.failureReason}
            </div>
          )}

          {/* Gate checklist, plain English */}
          <div className="mb-3 flex flex-wrap gap-2">
            {page.gates.map((g) => (
              <GateChip key={g.level} gate={g} />
            ))}
          </div>

          {/* Before / after JSON */}
          {(page.before != null || page.after != null) && (
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <h4 className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">
                  Before
                </h4>
                <pre className="max-h-60 overflow-auto rounded-md bg-surface-3 p-3 text-[11px] text-text-secondary">
                  {page.before != null
                    ? JSON.stringify(page.before, null, 2)
                    : "No schema found"}
                </pre>
              </div>
              <div>
                <h4 className="mb-1 text-[10px] uppercase tracking-wider text-fix-bright">
                  After (SchemaGen)
                </h4>
                <pre className="max-h-60 overflow-auto rounded-md bg-surface-3 p-3 text-[11px] text-text-secondary">
                  {page.after != null ? JSON.stringify(page.after, null, 2) : "—"}
                </pre>
              </div>
            </div>
          )}

          <a
            href={page.googleTestUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-[11px] font-semibold text-text-primary hover:bg-surface-3"
          >
            {googleLabel} <span aria-hidden>→</span>
          </a>
        </div>
      )}
    </div>
  );
}

function DispositionBadge({ disposition }: { disposition: ReportPage["disposition"] }) {
  const styles: Record<ReportPage["disposition"], string> = {
    already_good: "bg-valid/10 text-valid",
    fixed: "bg-fix/10 text-fix-bright",
    generated: "bg-fix/10 text-fix-bright",
    failed: "bg-error/10 text-error",
    rolled_back: "bg-error/[0.06] text-error",
    skipped: "bg-surface-2 text-text-muted",
  };
  const labels: Record<ReportPage["disposition"], string> = {
    already_good: "Already Good",
    fixed: "Fixed ✓",
    generated: "Generated ✓",
    failed: "Failed",
    rolled_back: "Rolled Back",
    skipped: "Not Checked",
  };
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${styles[disposition]}`}
    >
      {labels[disposition]}
    </span>
  );
}

/** Compact pass/fail dots for the collapsed row, one per gate (L0..L4). */
function GateDots({ gates }: { gates: ReportGate[] }) {
  return (
    <span className="flex items-center gap-1" title={gateTitle(gates)}>
      {gates.map((g) => (
        <span
          key={g.level}
          className={`h-1.5 w-1.5 rounded-full ${
            g.passed === true ? "bg-valid" : g.passed === false ? "bg-error" : "bg-surface-3"
          }`}
        />
      ))}
    </span>
  );
}

function GateChip({ gate }: { gate: ReportGate }) {
  const tone =
    gate.passed === true
      ? "border-valid/25 bg-valid/[0.06] text-valid"
      : gate.passed === false
        ? "border-error/25 bg-error-dim/20 text-error"
        : "border-border bg-surface-2 text-text-muted";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${tone}`}
      title={gate.detail}
    >
      {gate.passed === true ? "✓" : gate.passed === false ? "✕" : "–"} {gate.label}
    </span>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function gateTitle(gates: ReportGate[]): string {
  return gates
    .map(
      (g) =>
        `${g.label}: ${g.passed === true ? "pass" : g.passed === false ? "fail" : "not evaluated"}`
    )
    .join(" · ");
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
