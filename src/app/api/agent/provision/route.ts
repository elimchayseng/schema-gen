import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import type { Goal } from "@/lib/agent/types";

/**
 * POST /api/agent/provision — the one-click entry point from the landing page.
 *
 * Takes a merchant homepage URL, normalizes it to a domain, upserts the `sites`
 * row for this user+domain (same upsert the crawl route uses), and returns the
 * default one-shot Goal the agent surface should run.
 *
 * Intentionally thin: no sitemap fetch, no crawl rows, no theme access. The agent
 * run itself (POST /api/agent/run) resolves the sitemap from the domain. Later
 * rounds extend this endpoint (e.g. Shopify OAuth handshake) — the response
 * contract { siteId, domain, goal } must stay stable.
 */
const bodySchema = z.object({
  url: z.string().min(1, "URL is required"),
});

/** Looks like a real hostname after normalization (e.g. "store.com"). */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof z.ZodError ? err.issues[0].message : "Invalid request" },
      { status: 400 }
    );
  }

  // Normalize to a bare domain — same normalization as POST /api/crawl.
  const normalizedDomain = body.url
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();

  if (!DOMAIN_RE.test(normalizedDomain)) {
    return NextResponse.json(
      { error: "Enter a valid store URL, e.g. https://your-store.com" },
      { status: 400 }
    );
  }

  // Upsert the site for this user+domain (idempotent — re-provisioning is safe).
  const { data: site, error: siteError } = await supabase
    .from("sites")
    .upsert(
      { user_id: user.id, domain: normalizedDomain },
      { onConflict: "user_id,domain" }
    )
    .select("id")
    .single();

  if (siteError || !site) {
    console.error("[agent/provision] site upsert failed:", siteError);
    return NextResponse.json(
      { error: "Failed to create site record", detail: siteError?.message },
      { status: 500 }
    );
  }

  // The default one-shot goal: the whole site, one button (issues #27/#28).
  // Scope "site" derives per-page required types from the page-type matrix, so
  // requireTypes stays empty; minOutcome "rich_results_eligible" holds the
  // rich-capable types (Product, BreadcrumbList, Organization, ...) to the rich
  // bar while WebSite/CollectionPage/etc. are only ever required to validate.
  // allowSchemaTypeChange is required by the Goal type and defaults to false
  // (novel type changes stay gated), matching /api/agent/run's default.
  const goal: Goal = {
    siteId: site.id,
    target: {
      scope: "site",
      requireTypes: [],
      minOutcome: "rich_results_eligible",
    },
    constraints: {
      maxPages: 50,
      allowSchemaTypeChange: false,
    },
    autonomy: "auto_apply",
  };

  return NextResponse.json({
    siteId: site.id,
    domain: normalizedDomain,
    goal,
  });
}
