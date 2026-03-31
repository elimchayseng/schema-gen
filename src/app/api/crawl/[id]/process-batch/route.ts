import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { processPage } from "@/lib/crawl/process-page";
import type { BatchResult, PageResult } from "@/lib/crawl/types";

const BATCH_SIZE = 1;

/**
 * POST /api/crawl/[id]/process-batch — Process the next batch of pending pages.
 * Called by the frontend in a loop until all pages are processed.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: crawlId } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify crawl belongs to user
  const { data: crawl, error: crawlError } = await supabase
    .from("crawl_jobs")
    .select("*, sites!inner(user_id)")
    .eq("id", crawlId)
    .eq("sites.user_id", user.id)
    .single();

  if (crawlError || !crawl) {
    return NextResponse.json({ error: "Crawl not found" }, { status: 404 });
  }

  // Claim a batch of pending pages (also reclaim stale processing pages)
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const { data: pendingPages, error: fetchError } = await supabase
    .from("page_schemas")
    .select("id, url")
    .eq("crawl_id", crawlId)
    .or(`status.eq.pending,and(status.eq.processing,processing_started_at.lt.${twoMinAgo})`)
    .limit(BATCH_SIZE);

  if (fetchError) {
    return NextResponse.json({ error: "Failed to fetch pending pages" }, { status: 500 });
  }

  if (!pendingPages || pendingPages.length === 0) {
    // No pending pages — mark crawl as completed
    await supabase
      .from("crawl_jobs")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", crawlId);

    return NextResponse.json({
      processed: 0,
      remaining: 0,
      crawlComplete: true,
      pages: [],
    } satisfies BatchResult);
  }

  // Mark pages as processing
  const pageIds = pendingPages.map((p) => p.id);
  await supabase
    .from("page_schemas")
    .update({ status: "processing", processing_started_at: new Date().toISOString() })
    .in("id", pageIds);

  // Process each page
  const pageResults: PageResult[] = [];

  for (const page of pendingPages) {
    const result = await processPage(page.url, "scan");
    pageResults.push(result);

    // Write result to DB with try/catch (critical gap fix)
    try {
      await supabase
        .from("page_schemas")
        .update({
          status: result.status,
          original_schema: result.originalSchemas,
          fixed_schema: result.fixedSchemas,
          validation_results: result.validationResults,
          error_reason: result.errorReason ?? null,
          processed_at: new Date().toISOString(),
        })
        .eq("id", page.id);

      // Promote valid/warnings schemas to the main schemas table
      if (
        (result.status === "valid" || result.status === "warnings") &&
        result.validationResults?.schemas
      ) {
        for (const ps of result.validationResults.schemas) {
          let pagePath: string;
          try {
            pagePath = new URL(page.url).pathname;
          } catch {
            pagePath = page.url;
          }
          await supabase.from("schemas").upsert(
            {
              user_id: user.id,
              name: `${pagePath} — ${ps.type}`,
              schema_type: ps.type,
              content: ps.fixed,
              source_url: page.url,
              validation_errors:
                ps.validation.errors.length > 0 ? ps.validation.errors : null,
            },
            { onConflict: "user_id,source_url,schema_type" }
          );
        }
      }
    } catch {
      // DB write failure — mark as failed so it can be retried
      try {
        await supabase
          .from("page_schemas")
          .update({
            status: "failed",
            error_reason: "Database write failed",
            processed_at: new Date().toISOString(),
          })
          .eq("id", page.id);
      } catch {
        // Last resort, ignore nested failure
      }
    }
  }

  // Update crawl job progress (read + write since no RPC)
  const processedCount = pageResults.length;
  const { data: current } = await supabase
    .from("crawl_jobs")
    .select("processed_urls")
    .eq("id", crawlId)
    .single();
  if (current) {
    await supabase
      .from("crawl_jobs")
      .update({ processed_urls: current.processed_urls + processedCount })
      .eq("id", crawlId);
  }

  // Check remaining
  const { count: remaining } = await supabase
    .from("page_schemas")
    .select("id", { count: "exact", head: true })
    .eq("crawl_id", crawlId)
    .eq("status", "pending");

  const crawlComplete = (remaining ?? 0) === 0;

  if (crawlComplete) {
    await supabase
      .from("crawl_jobs")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", crawlId);
  }

  return NextResponse.json({
    processed: processedCount,
    remaining: remaining ?? 0,
    crawlComplete,
    pages: pageResults,
    processingPageUrl: pendingPages[0]?.url ?? null,
  });
}
