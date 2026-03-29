"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import type { CrawlStatusResponse, CrawlPhase } from "@/lib/crawl/types";

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

// Track which pages were fixed and their prior status
interface FixTransition {
  url: string;
  priorStatus: string;
}

// Avg tokens per page type (rough estimates for display)
const TOKENS_PER_SCAN = 200;
const TOKENS_PER_FIX = 2400;

export default function SiteDashboard() {
  const { id: crawlId } = useParams<{ id: string }>();
  const router = useRouter();

  const [crawlStatus, setCrawlStatus] = useState<CrawlStatusResponse | null>(null);
  const [pages, setPages] = useState<PageSchemaRow[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPage, setExpandedPage] = useState<string | null>(null);
  const [processingUrl, setProcessingUrl] = useState<string | null>(null);
  const [fixingUrl, setFixingUrl] = useState<string | null>(null);
  const [fixTransitions, setFixTransitions] = useState<FixTransition[]>([]);
  const [scanStartTime, setScanStartTime] = useState<number | null>(null);
  const [fixStartTime, setFixStartTime] = useState<number | null>(null);
  const [scanDuration, setScanDuration] = useState<number | null>(null);
  const [fixDuration, setFixDuration] = useState<number | null>(null);
  const stopRef = useRef(false);

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

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Process batch loop
  const startProcessing = useCallback(async () => {
    setIsProcessing(true);
    stopRef.current = false;
    if (!scanStartTime) setScanStartTime(Date.now());

    while (!stopRef.current) {
      try {
        const res = await fetch(`/api/crawl/${crawlId}/process-batch`, {
          method: "POST",
        });
        if (!res.ok) break;

        const data = await res.json();
        setProcessingUrl(data.processingPageUrl ?? null);
        await fetchData();

        if (data.crawlComplete) {
          setScanDuration(Date.now() - (scanStartTime ?? Date.now()));
          break;
        }
      } catch {
        break;
      }
    }

    setIsProcessing(false);
    setProcessingUrl(null);
  }, [crawlId, fetchData, scanStartTime]);

  // Auto-start ONLY if phase is "scanning" (not interrupted)
  useEffect(() => {
    if (
      crawlStatus?.phase === "scanning" &&
      !isProcessing &&
      !isFixing
    ) {
      startProcessing();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crawlStatus?.phase]);

  // Fix All loop
  const startFixAll = useCallback(async () => {
    setIsFixing(true);
    setFixStartTime(Date.now());

    while (true) {
      try {
        const res = await fetch(`/api/crawl/${crawlId}/fix-all`, {
          method: "POST",
        });
        if (!res.ok) break;

        const data = await res.json();

        // Record transition for the page that was just fixed
        if (data.priorStatus && data.fixingPageUrl) {
          setFixTransitions((prev) => {
            if (prev.some((t) => t.url === data.fixingPageUrl)) return prev;
            return [...prev, { url: data.fixingPageUrl, priorStatus: data.priorStatus }];
          });
        }

        // Show the NEXT page being processed, not the one just completed
        setFixingUrl(data.nextFixingPageUrl ?? null);

        await fetchData();

        if (data.fixComplete) {
          setFixDuration(Date.now() - (fixStartTime ?? Date.now()));
          break;
        }
      } catch {
        break;
      }
    }

    setIsFixing(false);
    setFixingUrl(null);
  }, [crawlId, fetchData, fixStartTime]);

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

  // Resume handlers
  const handleResumeScan = () => startProcessing();
  const handleResumeFix = () => startFixAll();

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

  const { results: counts, phase } = crawlStatus;
  const totalProcessed =
    counts.valid + counts.warnings + counts.errors + counts.no_schema + counts.failed;
  const scanProgress = crawlStatus.totalUrls > 0
    ? Math.round((totalProcessed / crawlStatus.totalUrls) * 100)
    : 0;
  const fixProgress = crawlStatus.fixTotal > 0
    ? Math.round((crawlStatus.fixProcessed / crawlStatus.fixTotal) * 100)
    : 0;
  const needsFix = counts.errors + counts.warnings + counts.no_schema;

  // Estimate tokens
  const estimatedTokens = totalProcessed * TOKENS_PER_SCAN + crawlStatus.fixProcessed * TOKENS_PER_FIX;

  // ETA calculations
  const avgScanTime = scanStartTime && totalProcessed > 0
    ? Math.round((Date.now() - scanStartTime) / totalProcessed / 1000)
    : 6;
  const scanRemaining = crawlStatus.totalUrls - totalProcessed;
  const scanEtaSeconds = scanRemaining * avgScanTime;

  const avgFixTime = fixStartTime && crawlStatus.fixProcessed > 0
    ? Math.round((Date.now() - fixStartTime) / crawlStatus.fixProcessed / 1000)
    : 20;
  const fixRemaining = crawlStatus.fixTotal - crawlStatus.fixProcessed;
  const fixEtaSeconds = fixRemaining * avgFixTime;

  // Relative time for interrupt banners
  const lastActivityAgo = crawlStatus.lastActivityAt
    ? formatTimeAgo(new Date(crawlStatus.lastActivityAt))
    : "unknown";

  // Split pages for different states
  const completedPages = pages.filter(
    (p) => !["pending", "processing"].includes(p.status)
  );
  const queuedPages = pages.filter((p) =>
    ["pending", "processing"].includes(p.status)
  );
  const fixablePages = pages.filter((p) =>
    ["errors", "warnings", "no_schema"].includes(p.status)
  );
  const fixedPages = pages.filter(
    (p) => p.fixed_schema && ["valid", "warnings"].includes(p.status)
  );

  // Determine active phase for UI
  const effectivePhase: CrawlPhase =
    isProcessing ? "scanning" :
    isFixing ? "fixing" :
    phase;

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

      {/* Phase Stepper */}
      <PhaseStepperBar phase={effectivePhase} scanCount={totalProcessed} scanTotal={crawlStatus.totalUrls} fixCount={crawlStatus.fixProcessed} fixTotal={crawlStatus.fixTotal} />

      {/* Interrupt Banners */}
      {effectivePhase === "interrupted_scan" && (
        <InterruptBanner
          title="Scan Paused"
          subtitle={`${totalProcessed} of ${crawlStatus.totalUrls} pages scanned. ${scanRemaining} pages remaining.`}
          lastActiveAgo={lastActivityAgo}
          stoppedOnUrl={crawlStatus.lastProcessedUrl}
          onResume={handleResumeScan}
          resumeLabel="Resume Scan"
        />
      )}
      {effectivePhase === "interrupted_fix" && (
        <InterruptBanner
          title="Fix Paused"
          subtitle={`${crawlStatus.fixProcessed} of ${crawlStatus.fixTotal} pages fixed. ${fixRemaining} pages remaining.`}
          lastActiveAgo={lastActivityAgo}
          stoppedOnUrl={crawlStatus.lastProcessedUrl}
          onResume={handleResumeFix}
          resumeLabel="Resume Fix"
        />
      )}

      {/* Scan Complete Gate */}
      {effectivePhase === "scan_complete" && (
        <GateBanner
          needsFix={needsFix}
          errorCount={counts.errors}
          warningCount={counts.warnings}
          noSchemaCount={counts.no_schema}
          scanDuration={scanDuration}
          onFixAll={startFixAll}
          onExport={handleExport}
          isFixing={isFixing}
        />
      )}

      {/* Done Banner */}
      {effectivePhase === "done" && (
        <DoneBanner
          counts={counts}
          scanDuration={scanDuration}
          fixDuration={fixDuration}
          estimatedTokens={estimatedTokens}
          totalUrls={crawlStatus.totalUrls}
          onExport={handleExport}
        />
      )}

      {/* Progress Bar (scanning or fixing) */}
      {(effectivePhase === "scanning" || effectivePhase === "interrupted_scan") && (
        <ProgressSection
          label={effectivePhase === "scanning" ? `Scanning... ${totalProcessed} of ${crawlStatus.totalUrls} pages` : `Paused at ${totalProcessed} of ${crawlStatus.totalUrls} pages`}
          progress={scanProgress}
          variant={effectivePhase === "scanning" ? "scan" : "paused"}
          eta={effectivePhase === "scanning" ? `~${formatDuration(scanEtaSeconds)} remaining · avg ${avgScanTime}s per page` : undefined}
        />
      )}
      {(effectivePhase === "fixing" || effectivePhase === "interrupted_fix") && (
        <ProgressSection
          label={effectivePhase === "fixing" ? `Fixing... ${crawlStatus.fixProcessed} of ${crawlStatus.fixTotal} pages` : `Paused at ${crawlStatus.fixProcessed} of ${crawlStatus.fixTotal} pages`}
          progress={fixProgress}
          variant={effectivePhase === "fixing" ? "fix" : "paused"}
          eta={effectivePhase === "fixing" ? `~${formatDuration(fixEtaSeconds)} remaining · avg ${avgFixTime}s per page (AI generation)` : undefined}
        />
      )}

      {/* Condensed Stats Bar */}
      <StatsBar counts={counts} />

      {/* Active Page Card (scanning) */}
      {effectivePhase === "scanning" && processingUrl && (
        <>
          <div className="mb-2 pl-1 font-serif text-[11px] uppercase tracking-wider text-text-muted">
            Now Processing
          </div>
          <ActivePageCard url={processingUrl} mode="scan" />
        </>
      )}

      {/* Active Page Card (fixing) */}
      {effectivePhase === "fixing" && fixingUrl && (
        <>
          <div className="mb-2 pl-1 font-serif text-[11px] uppercase tracking-wider text-text-muted">
            Now Fixing
          </div>
          <ActivePageCard url={fixingUrl} mode="fix" />
        </>
      )}

      {/* Page List */}
      <PageList
        phase={effectivePhase}
        pages={pages}
        completedPages={completedPages}
        queuedPages={queuedPages}
        fixTransitions={fixTransitions}
        expandedPage={expandedPage}
        onToggle={(id) => setExpandedPage(expandedPage === id ? null : id)}
      />
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function PhaseStepperBar({
  phase,
  scanCount,
  scanTotal,
  fixCount,
  fixTotal,
}: {
  phase: CrawlPhase;
  scanCount: number;
  scanTotal: number;
  fixCount: number;
  fixTotal: number;
}) {
  const scanDone = ["scan_complete", "fixing", "interrupted_fix", "done"].includes(phase);
  const scanActive = ["scanning"].includes(phase);
  const scanPaused = phase === "interrupted_scan";
  const fixDone = phase === "done";
  const fixActive = phase === "fixing";
  const fixPaused = phase === "interrupted_fix";
  const fixReady = phase === "scan_complete";

  const stepNumClass = (done: boolean, active: boolean, paused: boolean, ready?: boolean) => {
    if (done) return "bg-valid text-white";
    if (active) return phase === "fixing" ? "bg-fix text-white shadow-[0_0_12px_rgba(79,70,229,0.25)]" : "bg-valid text-white shadow-[0_0_12px_rgba(16,185,129,0.25)]";
    if (paused) return "bg-surface-3 text-text-secondary border border-border-bright";
    if (ready) return "bg-fix/20 text-fix-bright border border-fix/35";
    return "bg-surface-3 text-text-muted";
  };

  const stepTextClass = (done: boolean, active: boolean, paused: boolean, ready?: boolean) => {
    if (done) return "text-valid";
    if (active) return phase === "fixing" ? "text-fix-bright" : "text-valid";
    if (paused) return "text-text-secondary";
    if (ready) return "text-fix-bright";
    return "text-text-muted";
  };

  return (
    <div className="mb-5 flex items-center gap-0 rounded-lg border border-border bg-surface-1 px-5 py-3.5">
      <div className="flex items-center gap-2.5">
        <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${stepNumClass(scanDone, scanActive, scanPaused)}`}>
          {scanDone ? "✓" : "1"}
        </div>
        <div>
          <div className={`text-[13px] font-medium ${stepTextClass(scanDone, scanActive, scanPaused)}`}>Scan</div>
          <div className={`text-[10px] ${scanPaused || scanActive || scanDone ? "text-text-secondary" : "text-border-bright"}`}>
            {scanCount} of {scanTotal}
          </div>
        </div>
      </div>
      <div className={`mx-5 h-0.5 flex-1 ${scanDone ? "bg-valid" : "bg-surface-3"}`} />
      <div className="flex items-center gap-2.5">
        <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${stepNumClass(fixDone, fixActive, fixPaused, fixReady)}`}>
          {fixDone ? "✓" : "2"}
        </div>
        <div>
          <div className={`text-[13px] font-medium ${stepTextClass(fixDone, fixActive, fixPaused, fixReady)}`}>Fix</div>
          <div className={`text-[10px] ${fixPaused || fixActive || fixDone ? "text-text-secondary" : "text-border-bright"}`}>
            {fixActive || fixPaused || fixDone ? `${fixCount} of ${fixTotal}` : fixReady ? "Ready" : "Waiting"}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatsBar({ counts }: { counts: CrawlStatusResponse["results"] }) {
  return (
    <div className="mb-5 flex items-center overflow-hidden rounded-lg border border-border bg-surface-1">
      <StatCell num={counts.valid} label="Valid" color="text-valid" />
      <StatCell num={counts.warnings} label="Warnings" color="text-warn" />
      <StatCell num={counts.errors} label="Errors" color="text-error" />
      <StatCell num={counts.no_schema} label="No Schema" color="text-text-muted" />
      <StatCell num={counts.failed} label="Failed" color="text-text-muted" last />
    </div>
  );
}

function StatCell({ num, label, color, last }: { num: number; label: string; color: string; last?: boolean }) {
  return (
    <div className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 ${last ? "" : "border-r border-border"}`}>
      <span className={`font-mono text-base font-bold ${color}`}>{num}</span>
      <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
    </div>
  );
}

function ProgressSection({
  label,
  progress,
  variant,
  eta,
}: {
  label: string;
  progress: number;
  variant: "scan" | "fix" | "paused";
  eta?: string;
}) {
  const fillClass = variant === "scan" ? "bg-gradient-to-r from-valid to-accent-bright" : variant === "fix" ? "bg-gradient-to-r from-fix to-fix-bright" : "bg-text-muted";
  const borderClass = variant === "fix" ? "border-fix/20" : variant === "paused" ? "border-border-bright" : "border-border";

  return (
    <div className={`mb-4 rounded-lg border bg-surface-1 px-4 py-3.5 ${borderClass}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-text-secondary">{label}</span>
        <span className="text-xs text-text-muted">{progress}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full transition-all duration-500 ${fillClass}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      {eta && (
        <div className="mt-1.5 text-[11px] text-text-muted">{eta}</div>
      )}
    </div>
  );
}

function ActivePageCard({
  url,
  mode,
}: {
  url: string;
  mode: "scan" | "fix";
}) {
  let urlPath: string;
  try {
    urlPath = new URL(url).pathname;
  } catch {
    urlPath = url;
  }

  const isScan = mode === "scan";
  const borderColor = isScan ? "border-valid/20" : "border-fix/20";
  const topBarColor = isScan ? "from-valid to-accent-bright" : "from-fix to-fix-bright";
  const labelColor = isScan ? "text-valid" : "text-fix-bright";
  const pulseColor = isScan ? "bg-valid" : "bg-fix-bright";
  const urlColor = isScan ? "text-valid" : "text-fix-bright";

  return (
    <div className={`relative mb-5 rounded-lg border bg-surface-1 px-5 py-4 ${borderColor}`}>
      <div className={`absolute inset-x-0 top-0 h-0.5 rounded-t-lg bg-gradient-to-r ${topBarColor}`} />
      <div className={`mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest ${labelColor}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${pulseColor}`} style={{ animation: "crawl-pulse 1.5s infinite" }} />
        {isScan ? "Scanning" : "AI Fixing"}
      </div>
      <div className={`font-mono text-[13px] ${urlColor}`}>{urlPath}</div>
    </div>
  );
}

function InterruptBanner({
  title,
  subtitle,
  lastActiveAgo,
  stoppedOnUrl,
  onResume,
  resumeLabel,
}: {
  title: string;
  subtitle: string;
  lastActiveAgo: string;
  stoppedOnUrl: string | null;
  onResume: () => void;
  resumeLabel: string;
}) {
  let urlPath: string | null = null;
  if (stoppedOnUrl) {
    try {
      urlPath = new URL(stoppedOnUrl).pathname;
    } catch {
      urlPath = stoppedOnUrl;
    }
  }

  return (
    <div className="mb-5 overflow-hidden rounded-lg border border-border-bright bg-surface-1">
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-3 text-sm text-text-secondary">
          ⏸
        </div>
        <div>
          <div className="font-serif text-[15px] text-text-primary">{title}</div>
          <div className="text-xs text-text-secondary">{subtitle}</div>
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-border px-5 py-3">
        <div className="flex-1 text-[11px] text-text-muted">
          Last active <span className="text-text-secondary">{lastActiveAgo}</span>
          {urlPath && (
            <>
              {" · "}Stopped on <span className="font-mono text-text-secondary">{urlPath}</span>
            </>
          )}
        </div>
        <button
          onClick={onResume}
          className="rounded-md bg-text-primary px-4 py-2 text-xs font-semibold text-surface-0 hover:bg-text-secondary"
        >
          {resumeLabel}
        </button>
      </div>
    </div>
  );
}

function GateBanner({
  needsFix,
  errorCount,
  warningCount,
  noSchemaCount,
  scanDuration,
  onFixAll,
  onExport,
  isFixing,
}: {
  needsFix: number;
  errorCount: number;
  warningCount: number;
  noSchemaCount: number;
  scanDuration: number | null;
  onFixAll: () => void;
  onExport: () => void;
  isFixing: boolean;
}) {
  return (
    <div className="mb-5 overflow-hidden rounded-lg border border-border bg-surface-1">
      <div className="flex items-center gap-2.5 px-6 pt-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-valid/10 text-base text-valid">
          ✓
        </div>
        <h2 className="font-serif text-lg text-text-primary">Scan Complete</h2>
      </div>
      <div className="px-6 pb-5 pt-3">
        <p className="mb-4 text-xs text-text-secondary">
          {needsFix} pages need attention.
        </p>
        <div className="mb-5 flex gap-3">
          <div className="flex-1 rounded-md border border-border bg-surface-2 px-4 py-2.5 text-center">
            <div className="font-mono text-lg font-bold text-error">{errorCount}</div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Errors</div>
          </div>
          <div className="flex-1 rounded-md border border-border bg-surface-2 px-4 py-2.5 text-center">
            <div className="font-mono text-lg font-bold text-warn">{warningCount}</div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Warnings</div>
          </div>
          <div className="flex-1 rounded-md border border-border bg-surface-2 px-4 py-2.5 text-center">
            <div className="font-mono text-lg font-bold text-text-muted">{noSchemaCount}</div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">No Schema</div>
          </div>
        </div>
        <div className="flex gap-3">
          <button
            onClick={onFixAll}
            disabled={isFixing}
            className="rounded-md bg-fix px-7 py-2.5 text-[13px] font-semibold text-white hover:bg-fix-dim disabled:opacity-50"
          >
            Fix All ({needsFix} pages)
          </button>
          <button
            onClick={onExport}
            className="rounded-md border border-border bg-surface-2 px-5 py-2.5 text-xs font-semibold text-text-primary hover:bg-surface-3"
          >
            Export ZIP as-is
          </button>
        </div>
      </div>
      {scanDuration != null && (
        <div className="border-t border-border bg-surface-card px-6 py-3">
          <span className="text-[11px] text-text-muted">
            Scanned in <span className="text-text-secondary">{formatDuration(scanDuration / 1000)}</span>
          </span>
        </div>
      )}
    </div>
  );
}

function DoneBanner({
  counts,
  scanDuration,
  fixDuration,
  estimatedTokens,
  totalUrls,
  onExport,
}: {
  counts: CrawlStatusResponse["results"];
  scanDuration: number | null;
  fixDuration: number | null;
  estimatedTokens: number;
  totalUrls: number;
  onExport: () => void;
}) {
  const totalDuration = (scanDuration ?? 0) + (fixDuration ?? 0);
  const couldntFix = counts.errors;

  return (
    <div className="mb-5 overflow-hidden rounded-lg border border-border bg-surface-1">
      <div className="flex items-center gap-3 px-6 pt-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-valid/10 text-xl text-valid">
          ✓
        </div>
        <div>
          <h2 className="font-serif text-xl text-text-primary">All Done</h2>
          <p className="text-xs text-text-secondary">
            {totalUrls} pages scanned and optimized. Your schemas are ready.
          </p>
        </div>
      </div>
      <div className="px-6 pb-5 pt-4">
        <div className="mb-5 flex gap-3">
          <div className="flex-1 rounded-md border border-border bg-surface-2 px-4 py-3 text-center">
            <div className="font-mono text-xl font-bold text-valid">{counts.valid}</div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Valid</div>
          </div>
          <div className="flex-1 rounded-md border border-border bg-surface-2 px-4 py-3 text-center">
            <div className="font-mono text-xl font-bold text-warn">{counts.warnings}</div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Warnings</div>
          </div>
          <div className="flex-1 rounded-md border border-border bg-surface-2 px-4 py-3 text-center">
            <div className="font-mono text-xl font-bold text-error">{couldntFix}</div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Couldn&apos;t Fix</div>
          </div>
          <div className="flex-1 rounded-md border border-border bg-surface-2 px-4 py-3 text-center">
            <div className="font-mono text-xl font-bold text-text-muted">{counts.failed}</div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Failed</div>
          </div>
        </div>
        <div className="flex gap-3">
          <button
            onClick={onExport}
            className="rounded-md bg-valid px-7 py-2.5 text-[13px] font-semibold text-white hover:bg-valid/90"
          >
            Export ZIP
          </button>
          <button className="rounded-md border border-border bg-surface-2 px-5 py-2.5 text-xs font-semibold text-text-primary hover:bg-surface-3">
            Deploy to Site
          </button>
        </div>
      </div>
      <div className="flex items-center gap-1.5 border-t border-border bg-surface-card px-6 py-3 text-[11px] text-text-muted">
        {scanDuration != null && (
          <>
            <span>Scan <span className="text-text-secondary">{formatDuration(scanDuration / 1000)}</span></span>
            <span className="text-border">·</span>
          </>
        )}
        {fixDuration != null && (
          <>
            <span>Fix <span className="text-text-secondary">{formatDuration(fixDuration / 1000)}</span></span>
            <span className="text-border">·</span>
          </>
        )}
        {totalDuration > 0 && (
          <>
            <span>Total <span className="text-text-secondary">{formatDuration(totalDuration / 1000)}</span></span>
            <span className="text-border">·</span>
          </>
        )}
        <span>Tokens <span className="text-text-secondary">~{estimatedTokens.toLocaleString()}</span></span>
      </div>
    </div>
  );
}

function PageList({
  phase,
  pages,
  completedPages,
  queuedPages,
  fixTransitions,
  expandedPage,
  onToggle,
}: {
  phase: CrawlPhase;
  pages: PageSchemaRow[];
  completedPages: PageSchemaRow[];
  queuedPages: PageSchemaRow[];
  fixTransitions: FixTransition[];
  expandedPage: string | null;
  onToggle: (id: string) => void;
}) {
  // Build a map of URL → prior status for fix transitions
  const transitionMap = new Map(fixTransitions.map((t) => [t.url, t.priorStatus]));

  if (phase === "scanning" || phase === "interrupted_scan") {
    return (
      <>
        {completedPages.length > 0 && (
          <>
            <div className="mb-2 pl-1 font-serif text-[11px] uppercase tracking-wider text-text-muted">
              Completed ({completedPages.length})
            </div>
            <div className="mb-4 overflow-hidden rounded-lg border border-border">
              {completedPages.map((page) => (
                <PageRow key={page.id} page={page} expanded={expandedPage === page.id} onToggle={() => onToggle(page.id)} />
              ))}
            </div>
          </>
        )}
        {queuedPages.length > 0 && (
          <>
            <div className="mb-2 pl-1 font-serif text-[11px] uppercase tracking-wider text-text-muted">
              {phase === "interrupted_scan" ? `Not Started (${queuedPages.length})` : `Queued (${queuedPages.length})`}
            </div>
            <div className="mb-4 overflow-hidden rounded-lg border border-border">
              {queuedPages.map((page) => (
                <PageRow key={page.id} page={page} expanded={false} onToggle={() => {}} queued isInterrupt={phase === "interrupted_scan"} />
              ))}
            </div>
          </>
        )}
      </>
    );
  }

  if (phase === "fixing" || phase === "interrupted_fix") {
    // During fix: show all pages, with transitions for fixed ones
    const fixedSoFar = pages.filter((p) => p.fixed_schema && ["valid", "warnings"].includes(p.status));
    const stillNeedsFix = pages.filter((p) => ["errors", "warnings", "no_schema"].includes(p.status));
    const alreadyValid = pages.filter((p) => p.status === "valid" && !p.fixed_schema);
    const failed = pages.filter((p) => p.status === "failed");

    return (
      <>
        <div className="mb-2 pl-1 font-serif text-[11px] uppercase tracking-wider text-text-muted">
          Pages ({pages.length})
        </div>
        <div className="mb-4 overflow-hidden rounded-lg border border-border">
          {/* Already valid (untouched) */}
          {alreadyValid.map((page) => (
            <PageRow key={page.id} page={page} expanded={expandedPage === page.id} onToggle={() => onToggle(page.id)} />
          ))}
          {/* Fixed — show transition */}
          {fixedSoFar.map((page) => (
            <PageRow
              key={page.id}
              page={page}
              expanded={expandedPage === page.id}
              onToggle={() => onToggle(page.id)}
              priorStatus={transitionMap.get(page.url)}
            />
          ))}
          {/* Still needs fix */}
          {stillNeedsFix.map((page) => (
            <PageRow
              key={page.id}
              page={page}
              expanded={expandedPage === page.id}
              onToggle={() => onToggle(page.id)}
              fixQueued={phase === "fixing"}
            />
          ))}
          {/* Failed */}
          {failed.map((page) => (
            <PageRow key={page.id} page={page} expanded={expandedPage === page.id} onToggle={() => onToggle(page.id)} dimmed />
          ))}
        </div>
      </>
    );
  }

  // scan_complete or done — show all pages
  return (
    <>
      <div className="mb-2 pl-1 font-serif text-[11px] uppercase tracking-wider text-text-muted">
        All Pages ({pages.length})
      </div>
      <div className="mb-4 overflow-hidden rounded-lg border border-border">
        {pages.map((page) => (
          <PageRow
            key={page.id}
            page={page}
            expanded={expandedPage === page.id}
            onToggle={() => onToggle(page.id)}
            priorStatus={transitionMap.get(page.url)}
            dimmed={page.status === "failed"}
          />
        ))}
      </div>
    </>
  );
}

function PageRow({
  page,
  expanded,
  onToggle,
  queued,
  isInterrupt,
  priorStatus,
  fixQueued,
  dimmed,
}: {
  page: PageSchemaRow;
  expanded: boolean;
  onToggle: () => void;
  queued?: boolean;
  isInterrupt?: boolean;
  priorStatus?: string;
  fixQueued?: boolean;
  dimmed?: boolean;
}) {
  let urlPath: string;
  try {
    urlPath = new URL(page.url).pathname;
  } catch {
    urlPath = page.url;
  }

  const isFixed = page.fixed_schema && ["valid", "warnings"].includes(page.status) && priorStatus;

  return (
    <div className={dimmed ? "opacity-40" : ""}>
      <button
        onClick={onToggle}
        className={`flex w-full items-center gap-3 border-b border-surface-2 px-5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-surface-1 ${queued ? "opacity-35" : ""}`}
      >
        <span className={`flex-1 truncate font-mono text-xs ${queued ? "text-text-muted" : "text-valid"}`}>
          {urlPath}
        </span>
        {isFixed && priorStatus ? (
          <div className="flex items-center gap-1.5">
            <StatusBadge status={priorStatus} strikethrough />
            <span className="text-[11px] text-fix-bright">→</span>
            <StatusBadge status="fixed" />
          </div>
        ) : fixQueued ? (
          <span className="rounded-full bg-fix/[0.08] px-2.5 py-0.5 text-[10px] font-semibold text-fix-bright">
            Fix Queued
          </span>
        ) : queued ? (
          <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[10px] font-semibold text-border-bright">
            {isInterrupt ? "Not Started" : "Queued"}
          </span>
        ) : (
          <StatusBadge status={page.status} />
        )}
        {!queued && page.validation_results && (
          <span className="text-[10px] text-text-muted">
            {page.validation_results.errorCount}E / {page.validation_results.warningCount}W
          </span>
        )}
        {!queued && (
          <span className="text-[10px] text-text-muted">
            {expanded ? "▲" : "▼"}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-b border-surface-2 bg-surface-1 px-5 pb-4 pt-2">
          {page.error_reason && (
            <div className="mb-3 rounded-md border border-error/30 bg-error-dim/20 px-3 py-2 text-xs text-error">
              {page.error_reason}
            </div>
          )}
          {(page.original_schema || page.fixed_schema) && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <h4 className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">
                  Original
                </h4>
                <pre className="max-h-60 overflow-auto rounded-md bg-surface-3 p-3 text-[11px] text-text-secondary">
                  {page.original_schema
                    ? JSON.stringify(page.original_schema, null, 2)
                    : "No schema found"}
                </pre>
              </div>
              <div>
                <h4 className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">
                  Fixed
                </h4>
                <pre className="max-h-60 overflow-auto rounded-md bg-surface-3 p-3 text-[11px] text-text-secondary">
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

function StatusBadge({ status, strikethrough }: { status: string; strikethrough?: boolean }) {
  const styles: Record<string, string> = {
    valid: "bg-valid/10 text-valid",
    warnings: "bg-warn/10 text-warn",
    errors: "bg-error/10 text-error",
    no_schema: "bg-surface-2 text-text-muted",
    failed: "bg-error/[0.06] text-error",
    pending: "bg-surface-2 text-text-muted",
    processing: "bg-valid/10 text-valid",
    fixed: "bg-valid/10 text-valid",
  };

  const labels: Record<string, string> = {
    valid: "Valid",
    warnings: "Warnings",
    errors: "Errors",
    no_schema: "No Schema",
    failed: "Failed",
    pending: "Pending",
    processing: "Processing",
    fixed: "Fixed ✓",
  };

  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${styles[status] ?? styles.pending} ${strikethrough ? "line-through opacity-35" : ""}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours > 1 ? "s" : ""} ago`;
}
