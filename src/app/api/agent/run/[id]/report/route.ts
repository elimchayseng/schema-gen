import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase";
import {
  buildMerchantReport,
  type AgentActionRow,
  type AgentRunRow,
} from "@/lib/agent/report";

/**
 * GET /api/agent/run/[id]/report — the merchant-readable report for one run
 * (issue #30). Loads the run + its append-only actions and folds them through
 * the pure buildMerchantReport. Same auth/ownership pattern as the sibling
 * control route: agent_runs has RLS with no policies (server-only), so reads
 * use the service-role client AFTER the user-scoped client proves the run's
 * site belongs to the authenticated user.
 */

/** Verify ownership: returns the run's site_id if it belongs to `userId`, else null. */
async function authorizeRun(
  runId: string,
  userId: string,
  authedClient: Awaited<ReturnType<typeof createSupabaseServerClient>>
): Promise<{ siteId: string } | null> {
  const admin = createAdminClient();
  const { data: run } = await admin
    .from("agent_runs")
    .select("id, site_id")
    .eq("id", runId)
    .single();
  if (!run) return null;

  const siteId = (run as { site_id: string }).site_id;
  // The user-scoped client only sees the user's own sites — proves ownership.
  const { data: site } = await authedClient
    .from("sites")
    .select("id")
    .eq("id", siteId)
    .eq("user_id", userId)
    .single();
  if (!site) return null;
  return { siteId };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const owned = await authorizeRun(id, user.id, supabase);
  if (!owned) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const { data: run } = await admin
    .from("agent_runs")
    .select("*")
    .eq("id", id)
    .single();
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const { data: actions } = await admin
    .from("agent_actions")
    .select("*")
    .eq("run_id", id)
    .order("created_at", { ascending: true });

  const report = buildMerchantReport(
    run as AgentRunRow,
    (actions ?? []) as AgentActionRow[]
  );
  return NextResponse.json(report);
}
