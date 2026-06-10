import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import AgentRunner from "./AgentRunner";

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

  return (
    <AgentRunner
      crawlId={crawlId}
      siteId={row.site_id}
      domain={domain}
      hasShopCredentials={!!siteRow?.shop_domain}
    />
  );
}
