import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { fetchSitemap } from "@/lib/crawl/sitemap";

/**
 * GET /api/crawl — List all crawls for the current user.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: crawls } = await supabase
    .from("crawl_jobs")
    .select("id, status, total_urls, processed_urls, created_at, sites!inner(domain, user_id)")
    .eq("sites.user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  return NextResponse.json({ crawls: crawls ?? [] });
}

const bodySchema = z.object({
  domain: z.string().min(1, "Domain is required"),
});

/**
 * POST /api/crawl — Start a site-wide crawl.
 * Fetches sitemap, creates site + crawl_job + page_schemas rows.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse request body
  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof z.ZodError ? err.issues[0].message : "Invalid request" },
      { status: 400 }
    );
  }

  const { domain } = body;

  // Normalize domain
  const normalizedDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();

  // Rate limit: max 1 crawl per domain per hour per user
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: recentCrawls } = await supabase
    .from("crawl_jobs")
    .select("id, sites!inner(domain, user_id)")
    .eq("sites.user_id", user.id)
    .eq("sites.domain", normalizedDomain)
    .gte("created_at", oneHourAgo)
    .limit(1);

  if (recentCrawls && recentCrawls.length > 0) {
    return NextResponse.json(
      { error: "A crawl for this domain was started within the last hour. Please wait." },
      { status: 429 }
    );
  }

  // Fetch sitemap
  const sitemapResult = await fetchSitemap(normalizedDomain);

  if (sitemapResult.urls.length === 0) {
    return NextResponse.json(
      { error: sitemapResult.error ?? "No sitemap found for this domain" },
      { status: 404 }
    );
  }

  // Upsert site row
  const { data: site, error: siteError } = await supabase
    .from("sites")
    .upsert(
      { user_id: user.id, domain: normalizedDomain },
      { onConflict: "user_id,domain" }
    )
    .select("id")
    .single();

  if (siteError || !site) {
    console.error("[crawl] site upsert failed:", siteError);
    return NextResponse.json(
      { error: "Failed to create site record", detail: siteError?.message },
      { status: 500 }
    );
  }

  // Create crawl job
  const { data: crawlJob, error: crawlError } = await supabase
    .from("crawl_jobs")
    .insert({
      site_id: site.id,
      status: "running",
      total_urls: sitemapResult.urls.length,
      processed_urls: 0,
    })
    .select("id")
    .single();

  if (crawlError || !crawlJob) {
    console.error("[crawl] crawl_jobs insert failed:", crawlError);
    return NextResponse.json(
      { error: "Failed to create crawl job", detail: crawlError?.message },
      { status: 500 }
    );
  }

  // Insert page_schemas rows for all URLs
  const pageRows = sitemapResult.urls.map((u) => ({
    crawl_id: crawlJob.id,
    site_id: site.id,
    url: u.loc,
    status: "pending" as const,
  }));

  const { error: insertError } = await supabase
    .from("page_schemas")
    .insert(pageRows);

  if (insertError) {
    console.error("[crawl] page_schemas insert failed:", insertError);
    // Clean up crawl job on failure
    await supabase.from("crawl_jobs").delete().eq("id", crawlJob.id);
    return NextResponse.json(
      { error: "Failed to queue pages for crawl", detail: insertError?.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    crawlId: crawlJob.id,
    siteId: site.id,
    totalUrls: sitemapResult.urls.length,
    sitemapSource: sitemapResult.source,
    status: "running",
  });
}
