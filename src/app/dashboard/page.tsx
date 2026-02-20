import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import type { Schema } from "@/lib/database.types";
import SchemaCard from "@/components/SchemaCard";

async function getSchemas(): Promise<Schema[]> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("schemas")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) return [];
    return (data ?? []) as Schema[];
  } catch {
    return [];
  }
}

export default async function DashboardPage() {
  const schemas = await getSchemas();

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Workspace</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Manage your Shopify schema markup templates.
          </p>
        </div>
        <Link
          href="/editor"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
        >
          + New Schema
        </Link>
      </div>

      {schemas.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {schemas.map((schema) => (
            <SchemaCard key={schema.id} schema={schema} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center">
          <p className="text-zinc-500">
            No schemas yet.{" "}
            <Link href="/editor" className="text-indigo-400 hover:underline">
              Create your first one
            </Link>{" "}
            or{" "}
            <Link href="/validator" className="text-indigo-400 hover:underline">
              scan a URL
            </Link>{" "}
            to get started.
          </p>
        </div>
      )}
    </div>
  );
}
