import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { processPage } from "@/lib/crawl/process-page";

/**
 * POST /api/crawl/[id]/fix-all — Batch AI fix for all pages with issues.
 * Pages with errors/warnings → re-process in optimize mode (AI refine).
 * Pages with no_schema → AI generate from scratch.
 * Called by frontend in a loop (same pattern as process-batch).
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

  // Get pages that need fixing (errors, warnings, no_schema)
  const { data: pagesToFix } = await supabase
    .from("page_schemas")
    .select("id, url, status")
    .eq("crawl_id", crawlId)
    .in("status", ["errors", "warnings", "no_schema"])
    .limit(1); // Process 1 at a time so dashboard updates after each page

  if (!pagesToFix || pagesToFix.length === 0) {
    return NextResponse.json({
      processed: 0,
      remaining: 0,
      fixComplete: true,
    });
  }

  // Process each page in optimize mode
  const results = [];
  for (const page of pagesToFix) {
    // Mark as processing
    await supabase
      .from("page_schemas")
      .update({ status: "processing", processing_started_at: new Date().toISOString() })
      .eq("id", page.id);

    const result = await processPage(page.url, "optimize");
    results.push(result);

    // Update with results
    try {
      await supabase
        .from("page_schemas")
        .update({
          status: result.status,
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
      try {
        await supabase
          .from("page_schemas")
          .update({
            status: "failed",
            error_reason: "Database write failed during fix",
            processed_at: new Date().toISOString(),
          })
          .eq("id", page.id);
      } catch {
        // Ignore nested failure
      }
    }
  }

  // Count remaining pages that still need fixing
  const { count: remaining } = await supabase
    .from("page_schemas")
    .select("id", { count: "exact", head: true })
    .eq("crawl_id", crawlId)
    .in("status", ["errors", "warnings", "no_schema"]);

  return NextResponse.json({
    processed: results.length,
    remaining: remaining ?? 0,
    fixComplete: (remaining ?? 0) === 0,
  });
}
