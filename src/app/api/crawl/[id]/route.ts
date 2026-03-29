import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import type { CrawlStatusResponse, CrawlPhase } from "@/lib/crawl/types";

const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

/**
 * GET /api/crawl/[id] — Get crawl status, phase, and result counts.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fetch crawl job
  const { data: crawl, error: crawlError } = await supabase
    .from("crawl_jobs")
    .select("*, sites!inner(user_id)")
    .eq("id", id)
    .eq("sites.user_id", user.id)
    .single();

  if (crawlError || !crawl) {
    return NextResponse.json({ error: "Crawl not found" }, { status: 404 });
  }

  // Count page statuses
  const { data: statusCounts } = await supabase
    .from("page_schemas")
    .select("status")
    .eq("crawl_id", id);

  const counts = {
    valid: 0,
    warnings: 0,
    errors: 0,
    no_schema: 0,
    failed: 0,
    pending: 0,
    processing: 0,
  };

  if (statusCounts) {
    for (const row of statusCounts) {
      const s = row.status as keyof typeof counts;
      if (s in counts) counts[s]++;
    }
  }

  // Get last activity timestamp and last processed URL
  const { data: lastActivity } = await supabase
    .from("page_schemas")
    .select("processed_at, url")
    .eq("crawl_id", id)
    .not("processed_at", "is", null)
    .order("processed_at", { ascending: false })
    .limit(1)
    .single();

  const lastActivityAt = lastActivity?.processed_at ?? null;
  const lastProcessedUrl = lastActivity?.url ?? null;
  const isStale =
    lastActivityAt != null &&
    Date.now() - new Date(lastActivityAt).getTime() > STALE_THRESHOLD_MS;

  const needsFix = counts.errors + counts.warnings + counts.no_schema;
  const hasPending = counts.pending + counts.processing > 0;

  // Derive phase
  let phase: CrawlPhase;

  if (hasPending) {
    if (isStale || counts.processing === 0) {
      phase = "interrupted_scan";
    } else {
      phase = "scanning";
    }
  } else if (crawl.status === "running" && !hasPending) {
    phase = "scan_complete";
  } else if (crawl.status === "completed") {
    if (needsFix > 0) {
      if (counts.processing > 0 && !isStale) {
        phase = "fixing";
      } else if (counts.processing > 0 && isStale) {
        phase = "interrupted_fix";
      } else {
        phase = "scan_complete";
      }
    } else {
      phase = "done";
    }
  } else {
    phase = hasPending ? "scanning" : "done";
  }

  // Always compute fix progress from DB — not conditionally by phase.
  // A page is "fixed" if it has fixed_schema and landed on valid/warnings.
  const { count: fixedCount } = await supabase
    .from("page_schemas")
    .select("id", { count: "exact", head: true })
    .eq("crawl_id", id)
    .not("fixed_schema", "is", null)
    .in("status", ["valid", "warnings"]);

  const fixProcessed = fixedCount ?? 0;
  const fixTotal = fixProcessed + needsFix;

  const response: CrawlStatusResponse = {
    crawlId: id,
    status: crawl.status,
    phase,
    totalUrls: crawl.total_urls,
    processedUrls: crawl.processed_urls,
    lastActivityAt,
    lastProcessedUrl,
    fixTotal,
    fixProcessed,
    results: {
      valid: counts.valid,
      warnings: counts.warnings,
      errors: counts.errors,
      no_schema: counts.no_schema,
      failed: counts.failed,
      pending: counts.pending + counts.processing,
    },
  };

  // Also fetch page details
  const { data: pageDetails } = await supabase
    .from("page_schemas")
    .select("id, url, status, original_schema, fixed_schema, validation_results, error_reason")
    .eq("crawl_id", id)
    .order("url", { ascending: true });

  return NextResponse.json({
    ...response,
    pages: pageDetails ?? [],
  });
}
