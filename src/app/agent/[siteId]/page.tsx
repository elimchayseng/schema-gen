import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import AgentRunner from "@/app/site/[id]/agent/AgentRunner";

/**
 * Agent surface addressed by siteId — the landing page's provision flow lands here
 * (POST /api/agent/provision returns a siteId, not a crawlId, so this route exists
 * to start an agent run without requiring a prior crawl).
 *
 * Renders the existing AgentRunner unchanged. AgentRunner's `crawlId` prop is only
 * used for its "Back to dashboard" link, so we resolve the site's most recent crawl
 * for it; when the site has never been crawled we fall back to the siteId, which
 * lands the back link on the dashboard's graceful "Crawl not found" state.
 */
export default async function AgentBySitePage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Ownership check: the site must belong to the authenticated user.
  const { data: site } = await supabase
    .from("sites")
    .select("id, domain")
    .eq("id", siteId)
    .eq("user_id", user.id)
    .single();

  if (!site) notFound();

  // Most recent crawl for this site (if any) — only feeds the back link.
  const { data: latestCrawl } = await supabase
    .from("crawl_jobs")
    .select("id")
    .eq("site_id", siteId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <AgentRunner
      crawlId={latestCrawl?.id ?? siteId}
      siteId={site.id}
      domain={site.domain}
    />
  );
}
