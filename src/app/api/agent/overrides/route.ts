import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import {
  loadOverrides,
  deleteOverride,
  getOverride,
} from "@/lib/agent/overrides";

/**
 * /api/agent/overrides — list + remove sticky merchant overrides (issue #29).
 *
 *   GET    ?siteId=&url=  → { overrides: MerchantOverride[] }
 *   DELETE ?id=           → { ok: true } (un-sticks one correction)
 *
 * merchant_overrides has RLS enabled with no policies (server-only, like
 * agent_runs), so all reads/writes go through the service-role client AFTER
 * verifying the site belongs to the authenticated user — same pattern as
 * /api/agent/run/[id].
 */

/** Verify ownership: true iff `siteId` belongs to `userId`. */
async function ownsSite(
  siteId: string,
  userId: string,
  authedClient: Awaited<ReturnType<typeof createSupabaseServerClient>>
): Promise<boolean> {
  // The user-scoped client only sees the user's own sites — proves ownership.
  const { data: site } = await authedClient
    .from("sites")
    .select("id")
    .eq("id", siteId)
    .eq("user_id", userId)
    .single();
  return Boolean(site);
}

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const siteId = searchParams.get("siteId");
  const url = searchParams.get("url");
  if (!siteId || !url) {
    return NextResponse.json(
      { error: "siteId and url query params are required" },
      { status: 400 }
    );
  }

  if (!(await ownsSite(siteId, user.id, supabase))) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  try {
    const overrides = await loadOverrides(siteId, url);
    return NextResponse.json({ overrides });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: "id query param is required" },
      { status: 400 }
    );
  }

  try {
    const override = await getOverride(id);
    // 404 for both "doesn't exist" and "not yours" — don't leak row existence.
    if (
      !override ||
      !(await ownsSite(override.siteId, user.id, supabase))
    ) {
      return NextResponse.json({ error: "Override not found" }, { status: 404 });
    }

    await deleteOverride(id, override.siteId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
