import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { processPage } from "@/lib/crawl/process-page";
import type { ProgressStep } from "@/lib/crawl/process-page";

/**
 * POST /api/crawl/[id]/fix-all — Streams real-time progress via SSE.
 *
 * Processes one page per call. Sends progress events as each stage completes
 * (fetching, extracting, validating, ai_generating, refining, saving),
 * then a final "done" event with the full result payload.
 *
 * Frontend reads the stream to update the ActivePageCard in real time.
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

  // Get next page that needs fixing (not yet attempted)
  const { data: pagesToFix } = await supabase
    .from("page_schemas")
    .select("id, url, status")
    .eq("crawl_id", crawlId)
    .in("status", ["errors", "warnings", "no_schema"])
    .is("fix_attempted_at", null)
    .order("url", { ascending: true })
    .limit(1);

  if (!pagesToFix || pagesToFix.length === 0) {
    // No pages left — return JSON (not streaming) for the terminal case
    const { count: attemptedCount } = await supabase
      .from("page_schemas")
      .select("id", { count: "exact", head: true })
      .eq("crawl_id", crawlId)
      .not("fix_attempted_at", "is", null);

    return NextResponse.json({
      processed: 0,
      remaining: 0,
      fixComplete: true,
      fixingPageUrl: null,
      priorStatus: null,
      fixTotal: attemptedCount ?? 0,
      fixProcessed: attemptedCount ?? 0,
    });
  }

  const page = pagesToFix[0];
  const priorStatus = page.status;
  const mode = page.status === "no_schema" ? "optimize" : "scan";

  // Stream SSE events during processing
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Mark as processing
      await supabase
        .from("page_schemas")
        .update({ status: "processing", processing_started_at: new Date().toISOString() })
        .eq("id", page.id);

      // Process with real-time progress callbacks
      const onProgress = (step: ProgressStep, detail?: string) => {
        send({ step, url: page.url, detail: detail ?? null, mode });
      };

      const result = await processPage(page.url, mode, onProgress);

      // Save results
      send({ step: "saving", url: page.url, mode });

      try {
        await supabase
          .from("page_schemas")
          .update({
            status: result.status,
            fixed_schema: result.fixedSchemas ?? result.originalSchemas,
            validation_results: result.validationResults,
            error_reason: result.errorReason ?? null,
            processed_at: new Date().toISOString(),
            fix_attempted_at: new Date().toISOString(),
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
              fix_attempted_at: new Date().toISOString(),
            })
            .eq("id", page.id);
        } catch {
          // Ignore nested failure
        }
      }

      // Peek at the next unattempted page
      const { data: remainingPages } = await supabase
        .from("page_schemas")
        .select("id, url, status")
        .eq("crawl_id", crawlId)
        .in("status", ["errors", "warnings", "no_schema"])
        .is("fix_attempted_at", null)
        .order("url", { ascending: true })
        .limit(1);

      // Stable progress counts
      const { count: attemptedCount } = await supabase
        .from("page_schemas")
        .select("id", { count: "exact", head: true })
        .eq("crawl_id", crawlId)
        .not("fix_attempted_at", "is", null);

      const { count: remainingCount } = await supabase
        .from("page_schemas")
        .select("id", { count: "exact", head: true })
        .eq("crawl_id", crawlId)
        .in("status", ["errors", "warnings", "no_schema"])
        .is("fix_attempted_at", null);

      const fixProcessedCount = attemptedCount ?? 0;
      const fixTotalCount = fixProcessedCount + (remainingCount ?? 0);

      // Final event with full result payload
      send({
        step: "done",
        processed: 1,
        remaining: remainingCount ?? 0,
        fixComplete: (remainingCount ?? 0) === 0,
        fixingPageUrl: page.url,
        nextFixingPageUrl: remainingPages?.[0]?.url ?? null,
        nextPageStatus: remainingPages?.[0]?.status ?? null,
        priorStatus,
        fixTotal: fixTotalCount,
        fixProcessed: fixProcessedCount,
      });

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
