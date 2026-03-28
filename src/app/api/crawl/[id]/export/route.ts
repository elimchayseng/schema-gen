import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import JSZip from "jszip";

/**
 * GET /api/crawl/[id]/export — Download a ZIP of all fixed JSON-LD files.
 * File naming: url-path-slug.json organized by page path.
 */
export async function GET(
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

  // Verify crawl belongs to user and get site domain
  const { data: crawl, error: crawlError } = await supabase
    .from("crawl_jobs")
    .select("*, sites!inner(domain, user_id)")
    .eq("id", crawlId)
    .eq("sites.user_id", user.id)
    .single();

  if (crawlError || !crawl) {
    return NextResponse.json({ error: "Crawl not found" }, { status: 404 });
  }

  // Get all pages with fixed schemas
  const { data: pages, error: pagesError } = await supabase
    .from("page_schemas")
    .select("url, fixed_schema, status")
    .eq("crawl_id", crawlId)
    .not("fixed_schema", "is", null);

  if (pagesError || !pages || pages.length === 0) {
    return NextResponse.json(
      { error: "No fixed schemas to export" },
      { status: 404 }
    );
  }

  // Build ZIP
  const zip = new JSZip();
  const domain = (crawl as Record<string, unknown> & { sites: { domain: string } }).sites.domain;

  for (const page of pages) {
    // Convert URL to file path
    let urlPath: string;
    try {
      const parsed = new URL(page.url);
      urlPath = parsed.pathname;
    } catch {
      urlPath = page.url;
    }

    // Normalize path to filename
    const slug = urlPath
      .replace(/^\//, "") // Remove leading slash
      .replace(/\/$/, "") // Remove trailing slash
      .replace(/\//g, "_") // Replace slashes with underscores
      || "index";

    const filename = `${slug}.json`;

    // Write JSON-LD (array or single object)
    const schemas = page.fixed_schema;
    const content = JSON.stringify(
      Array.isArray(schemas) && schemas.length === 1 ? schemas[0] : schemas,
      null,
      2
    );

    zip.file(filename, content);
  }

  // Generate ZIP buffer
  const zipBuffer = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  // Return as download
  return new NextResponse(Buffer.from(zipBuffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${domain}-schemas.zip"`,
    },
  });
}
