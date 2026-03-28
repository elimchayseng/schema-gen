"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import type { CrawlStatusResponse, PageResult } from "@/lib/crawl/types";

interface PageSchemaRow {
  id: string;
  url: string;
  status: string;
  original_schema: Record<string, unknown>[] | null;
  fixed_schema: Record<string, unknown>[] | null;
  validation_results: {
    errorCount: number;
    warningCount: number;
  } | null;
  error_reason: string | null;
}

type ViewMode = "table" | "before-after";

export default function SiteDashboard() {
  const { id: crawlId } = useParams<{ id: string }>();
  const router = useRouter();

  const [crawlStatus, setCrawlStatus] = useState<CrawlStatusResponse | null>(null);
  const [pages, setPages] = useState<PageSchemaRow[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPage, setExpandedPage] = useState<string | null>(null);
  const stopRef = useRef(false);

  // Fetch crawl status + pages in one call
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/crawl/${crawlId}`);
      if (!res.ok) {
        setError("Crawl not found");
        return;
      }
      const data = await res.json();
      setCrawlStatus(data);
      setPages(data.pages ?? []);
    } catch {
      setError("Failed to load crawl status");
    }
  }, [crawlId]);

  // Initial load
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Process batch loop (client-orchestrated)
  const startProcessing = useCallback(async () => {
    setIsProcessing(true);
    stopRef.current = false;

    while (!stopRef.current) {
      try {
        const res = await fetch(`/api/crawl/${crawlId}/process-batch`, {
          method: "POST",
        });
        if (!res.ok) break;

        const data = await res.json();
        await fetchData();

        if (data.crawlComplete) break;
      } catch {
        break;
      }
    }

    setIsProcessing(false);
  }, [crawlId, fetchData]);

  // Auto-start processing if crawl is running and has pending pages
  useEffect(() => {
    if (
      crawlStatus?.status === "running" &&
      crawlStatus.results.pending > 0 &&
      !isProcessing
    ) {
      startProcessing();
    }
  }, [crawlStatus, isProcessing, startProcessing]);

  // Fix All loop
  const startFixAll = useCallback(async () => {
    setIsFixing(true);

    while (true) {
      try {
        const res = await fetch(`/api/crawl/${crawlId}/fix-all`, {
          method: "POST",
        });
        if (!res.ok) break;

        const data = await res.json();
        await fetchData();

        if (data.fixComplete) break;
      } catch {
        break;
      }
    }

    setIsFixing(false);
  }, [crawlId, fetchData]);

  // Export ZIP
  const handleExport = useCallback(async () => {
    const res = await fetch(`/api/crawl/${crawlId}/export`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `schemas.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }, [crawlId]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl pt-12">
        <div className="rounded-lg border border-error/30 bg-error-dim/20 px-5 py-4">
          <p className="text-sm text-error">{error}</p>
        </div>
        <button
          onClick={() => router.push("/")}
          className="mt-4 text-sm text-text-secondary hover:text-text-primary"
        >
          &larr; Back to home
        </button>
      </div>
    );
  }

  if (!crawlStatus) {
    return (
      <div className="mx-auto max-w-3xl pt-12 text-center">
        <div className="animate-pulse text-sm text-text-muted">
          Loading crawl data...
        </div>
      </div>
    );
  }

  const { results: counts } = crawlStatus;
  const totalProcessed =
    counts.valid + counts.warnings + counts.errors + counts.no_schema + counts.failed;
  const progress = crawlStatus.totalUrls > 0
    ? Math.round((totalProcessed / crawlStatus.totalUrls) * 100)
    : 0;
  const needsFix = counts.errors + counts.warnings + counts.no_schema;

  return (
    <div className="mx-auto max-w-4xl">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={() => router.push("/")}
          className="text-xs text-text-muted hover:text-text-secondary"
        >
          &larr; Home
        </button>
        <h1 className="font-serif text-lg text-text-primary">
          Site Crawl Results
        </h1>
        <span className="rounded-sm bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-text-secondary">
          {crawlStatus.totalUrls} pages
        </span>
      </div>

      {/* Progress bar (during crawl) */}
      {isProcessing && (
        <div className="mb-6 rounded-lg border border-border bg-surface-1 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-text-secondary">
              Crawling... {totalProcessed} of {crawlStatus.totalUrls} pages
            </span>
            <span className="text-xs text-text-muted">{progress}%</span>
          </div>
          <div className="h-2 rounded-full bg-surface-3 overflow-hidden">
            <div
              className="h-full rounded-full bg-valid transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Stats cards */}
      <div className="mb-6 grid grid-cols-5 gap-3">
        <StatCard label="Valid" count={counts.valid} variant="valid" />
        <StatCard label="Warnings" count={counts.warnings} variant="warn" />
        <StatCard label="Errors" count={counts.errors} variant="error" />
        <StatCard label="No Schema" count={counts.no_schema} variant="muted" />
        <StatCard label="Failed" count={counts.failed} variant="error" />
      </div>

      {/* Action bar */}
      <div className="mb-6 flex gap-3">
        {needsFix > 0 && (
          <button
            onClick={startFixAll}
            disabled={isFixing || isProcessing}
            className="rounded-md bg-valid px-4 py-2 text-xs font-semibold text-white hover:bg-valid/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isFixing ? `Fixing...` : `Fix All (${needsFix} pages)`}
          </button>
        )}
        {totalProcessed > 0 && (
          <button
            onClick={handleExport}
            disabled={isProcessing}
            className="rounded-md border border-border bg-surface-1 px-4 py-2 text-xs font-semibold text-text-primary hover:bg-surface-2 disabled:opacity-50"
          >
            Export ZIP
          </button>
        )}
        {crawlStatus.status === "completed" &&
          counts.pending > 0 && (
            <button
              onClick={startProcessing}
              disabled={isProcessing}
              className="rounded-md border border-border bg-surface-1 px-4 py-2 text-xs font-semibold text-text-primary hover:bg-surface-2"
            >
              Resume ({counts.pending} remaining)
            </button>
          )}
      </div>

      {/* Page table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="px-5 py-3 bg-surface-1 border-b border-border">
          <h2 className="font-serif text-xs uppercase tracking-wider text-text-muted">
            Pages
          </h2>
        </div>
        <div className="divide-y divide-border">
          {pages.length === 0 && !isProcessing && (
            <div className="px-5 py-8 text-center text-xs text-text-muted">
              {crawlStatus.status === "running"
                ? "Processing pages..."
                : "No pages scanned yet."}
            </div>
          )}
          {pages.map((page) => (
            <PageRow
              key={page.id}
              page={page}
              expanded={expandedPage === page.id}
              onToggle={() =>
                setExpandedPage(expandedPage === page.id ? null : page.id)
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Sub-components ---

function StatCard({
  label,
  count,
  variant,
}: {
  label: string;
  count: number;
  variant: "valid" | "warn" | "error" | "muted";
}) {
  const colorMap = {
    valid: "text-valid",
    warn: "text-warn",
    error: "text-error",
    muted: "text-text-muted",
  };

  return (
    <div className="rounded-lg border border-border bg-surface-1 p-3 text-center">
      <div className={`text-2xl font-bold ${colorMap[variant]}`}>{count}</div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted mt-1">
        {label}
      </div>
    </div>
  );
}

function PageRow({
  page,
  expanded,
  onToggle,
}: {
  page: PageSchemaRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  // Extract path from URL
  let urlPath: string;
  try {
    urlPath = new URL(page.url).pathname;
  } catch {
    urlPath = page.url;
  }

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-5 py-3 hover:bg-surface-1 text-left"
      >
        <span className="font-mono text-xs text-valid flex-1 truncate">
          {urlPath}
        </span>
        <StatusBadge status={page.status} />
        {page.validation_results && (
          <span className="text-[10px] text-text-muted">
            {page.validation_results.errorCount}E / {page.validation_results.warningCount}W
          </span>
        )}
        <span className="text-[10px] text-text-muted">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="px-5 pb-4 bg-surface-1">
          {page.error_reason && (
            <div className="mb-3 rounded-md border border-error/30 bg-error-dim/20 px-3 py-2 text-xs text-error">
              {page.error_reason}
            </div>
          )}

          {/* Before / After comparison */}
          {(page.original_schema || page.fixed_schema) && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <h4 className="text-[10px] uppercase tracking-wider text-text-muted mb-1">
                  Original
                </h4>
                <pre className="rounded-md bg-surface-3 p-3 text-[11px] text-text-secondary overflow-auto max-h-60">
                  {page.original_schema
                    ? JSON.stringify(page.original_schema, null, 2)
                    : "No schema found"}
                </pre>
              </div>
              <div>
                <h4 className="text-[10px] uppercase tracking-wider text-text-muted mb-1">
                  Fixed
                </h4>
                <pre className="rounded-md bg-surface-3 p-3 text-[11px] text-text-secondary overflow-auto max-h-60">
                  {page.fixed_schema
                    ? JSON.stringify(page.fixed_schema, null, 2)
                    : "—"}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    valid: "bg-valid/10 text-valid",
    warnings: "bg-warn/10 text-warn",
    errors: "bg-error/10 text-error",
    no_schema: "bg-surface-3 text-text-muted",
    failed: "bg-error/10 text-error",
    pending: "bg-surface-3 text-text-muted",
    processing: "bg-valid/10 text-valid animate-pulse",
  };

  const labels: Record<string, string> = {
    valid: "Valid",
    warnings: "Warnings",
    errors: "Errors",
    no_schema: "No Schema",
    failed: "Failed",
    pending: "Pending",
    processing: "Processing",
  };

  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${styles[status] ?? styles.pending}`}
    >
      {labels[status] ?? status}
    </span>
  );
}
