import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase";
import AgentRunner, { type LastRun } from "@/app/site/[id]/agent/AgentRunner";

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

  // Ownership check: the site must belong to the authenticated user. shop_domain
  // rides along — it unlocks the staging write modes in the runner.
  const { data: site } = await supabase
    .from("sites")
    .select("id, domain, shop_domain")
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

  // Rehydrate-on-mount, same as /site/[id]/agent: the most recent run for this
  // site, so a reload during/after a run shows the "Last run" card instead of a
  // blank form. Admin client: agent_runs has RLS with no user policies; ownership
  // was proven by the sites query above. Best-effort — a read failure just means
  // no card.
  let lastRun: LastRun | null = null;
  try {
    const admin = createAdminClient();
    const { data: runRow } = await admin
      .from("agent_runs")
      // select("*") not a column list: last_step only exists once migration 013 is
      // applied, and a missing column in an explicit list errors the whole select.
      .select("*")
      .eq("site_id", siteId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (runRow) lastRun = runRow as LastRun;
  } catch {
    /* no card */
  }

  return (
    <AgentRunner
      crawlId={latestCrawl?.id ?? siteId}
      siteId={site.id}
      domain={site.domain}
      hasShopCredentials={!!(site as { shop_domain?: string | null }).shop_domain}
      lastRun={lastRun}
    />
  );
}
