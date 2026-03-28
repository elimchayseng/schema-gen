import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import type { CrawlStatusResponse } from "@/lib/crawl/types";

/**
 * GET /api/crawl/[id] — Get crawl status and result counts.
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

  const response: CrawlStatusResponse = {
    crawlId: id,
    status: crawl.status,
    totalUrls: crawl.total_urls,
    processedUrls: crawl.processed_urls,
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
