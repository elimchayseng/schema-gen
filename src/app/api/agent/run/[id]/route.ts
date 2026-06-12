import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase";
import { setControl } from "@/lib/agent";

/**
 * /api/agent/run/[id] — the run CONTROL channel (not streaming). A separate, short request
 * from the long-lived POST /api/agent/run stream, so it reaches the in-flight run via the
 * DB (agent_runs.control), which the run loop polls.
 *
 *   GET  → the run row + its recent actions (reconnect / repaint gate results / diff fallback)
 *   POST → { control: "kill" } sets agent_runs.control. "kill" is the only control verb;
 *          anything else is rejected with 400 (pause/resume were removed).
 *
 * agent_runs has RLS enabled with no policies (server-only), so reads use the service-role
 * client AFTER verifying the run's site belongs to the authenticated user.
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
  const { data: actions } = await admin
    .from("agent_actions")
    .select("*")
    .eq("run_id", id)
    .order("created_at", { ascending: true });

  return NextResponse.json({ run, actions: actions ?? [] });
}

export async function POST(
  request: Request,
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

  let body: { control?: string };
  try {
    body = (await request.json()) as { control?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // "kill" is the only control verb. Pause/resume were reserved stubs that never
  // shipped — deleted rather than left as a 501 trap.
  if (body.control !== "kill") {
    return NextResponse.json(
      { error: "control must be 'kill'" },
      { status: 400 }
    );
  }

  try {
    await setControl(id, "kill");
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, control: "kill" });
}
