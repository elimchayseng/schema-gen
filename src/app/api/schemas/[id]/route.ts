import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";

// GET /api/schemas/[id] — single schema for editor load
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("schemas")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Schema not found" }, { status: 404 });
  }

  return NextResponse.json({ schema: data });
}

// DELETE /api/schemas/[id] — delete own schema
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { error, count } = await supabase
    .from("schemas")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (count === 0) {
    return NextResponse.json(
      { error: "Schema not found or access denied" },
      { status: 403 }
    );
  }

  return NextResponse.json({ success: true });
}
