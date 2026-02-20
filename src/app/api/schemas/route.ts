import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase-server";

// GET /api/schemas — returns all schemas, most recently updated first
export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("schemas")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ schemas: data ?? [] });
}

const upsertSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1, "Name is required"),
  schema_type: z.string().min(1, "Schema type is required"),
  content: z.record(z.string(), z.unknown()),
  source_url: z.string().url().optional().nullable(),
  validation_errors: z.array(z.unknown()).optional().nullable(),
  missing_opportunities: z.array(z.unknown()).optional().nullable(),
});

// POST /api/schemas — insert or update a schema
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 }
    );
  }

  const { id, ...fields } = parsed.data;

  if (id) {
    // Update existing schema — RLS enforces user_id match
    const { data, error } = await supabase
      .from("schemas")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json(
        { error: "Schema not found or access denied" },
        { status: 403 }
      );
    }
    return NextResponse.json({ schema: data });
  }

  // Insert new schema
  const { data, error } = await supabase
    .from("schemas")
    .insert({ ...fields, user_id: user.id })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ schema: data }, { status: 201 });
}
