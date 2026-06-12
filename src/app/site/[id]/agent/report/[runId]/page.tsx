import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase";
import {
  buildMerchantReport,
  type AgentActionRow,
  type AgentRunRow,
} from "@/lib/agent/report";
import MerchantReportView from "@/components/report-agent/MerchantReportView";

/**
 * Merchant report for one agent run (issue #30), nested under the agent surface:
 * /site/[id]/agent/report/[runId]. Like the sibling control route, ownership is
 * proven through the RUN (agent_runs.site_id → the user's own sites), so the page
 * is fully standalone given the two URL params — [id] (the crawlId, matching the
 * /site/[id] convention) is only used for the back link. agent_runs/agent_actions
 * have RLS with no policies (server-only), so data reads use the service-role
 * client AFTER the user-scoped client proves ownership.
 */
export default async function AgentReportPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id: crawlId, runId } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: run } = await admin
    .from("agent_runs")
    .select("*")
    .eq("id", runId)
    .single();
  if (!run) notFound();

  // The user-scoped client only sees the user's own sites — proves ownership.
  const { data: site } = await supabase
    .from("sites")
    .select("id")
    .eq("id", (run as { site_id: string }).site_id)
    .eq("user_id", user.id)
    .single();
  if (!site) notFound();

  const { data: actions } = await admin
    .from("agent_actions")
    .select("*")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  const report = buildMerchantReport(
    run as AgentRunRow,
    (actions ?? []) as AgentActionRow[]
  );

  return (
    <MerchantReportView report={report} backHref={`/site/${crawlId}/agent`} />
  );
}
