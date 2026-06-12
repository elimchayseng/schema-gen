import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase";
import AgentRunner, { type LastRun } from "./AgentRunner";

/**
 * Agent control surface (Phase 4), nested under the site dashboard. The route param `[id]`
 * is the crawlId (matching /site/[id]); the agent run itself needs the siteId, so this
 * server component resolves the crawl's site (with an ownership check) and hands the
 * client runner the siteId + domain.
 */
export default async function AgentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: crawlId } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: crawl } = await supabase
    .from("crawl_jobs")
    .select("id, site_id, sites!inner(domain, shop_domain, user_id)")
    .eq("id", crawlId)
    .eq("sites.user_id", user.id)
    .single();

  if (!crawl) notFound();

  const row = crawl as unknown as {
    site_id: string;
    sites:
      | { domain: string; shop_domain?: string | null }
      | { domain: string; shop_domain?: string | null }[];
  };
  const siteRow = Array.isArray(row.sites) ? row.sites[0] : row.sites;
  const domain = siteRow?.domain ?? "";

  // Rehydrate-on-mount: the most recent run for this site, so a reload after (or
  // during) a run shows a "Last run" card instead of a blank form — the run's result
  // lives in the DB; only the in-memory summary is lost on remount. Admin client:
  // agent_runs has RLS with no user policies; ownership was proven by the crawl
  // query above. Best-effort — a read failure just means no card.
  let lastRun: LastRun | null = null;
  try {
    const admin = createAdminClient();
    const { data: runRow } = await admin
      .from("agent_runs")
      // select("*") not a column list: last_step only exists once migration 013 is
      // applied, and a missing column in an explicit list errors the whole select.
      .select("*")
      .eq("site_id", row.site_id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (runRow) lastRun = runRow as LastRun;
  } catch {
    /* no card */
  }

  return (
    <AgentRunner
      crawlId={crawlId}
      siteId={row.site_id}
      domain={domain}
      hasShopCredentials={!!siteRow?.shop_domain}
      lastRun={lastRun}
    />
  );
}
