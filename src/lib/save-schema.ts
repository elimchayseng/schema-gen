import type { ValidationIssue } from "@/lib/validation/types";

export interface SaveSchemaParams {
  id?: string;
  name: string;
  schema_type: string;
  content: Record<string, unknown>;
  source_url?: string;
  validation_errors?: ValidationIssue[];
  missing_opportunities?: unknown[];
}

export async function saveSchema(
  params: SaveSchemaParams
): Promise<{ ok: boolean; schema?: Record<string, unknown>; error?: string }> {
  try {
    const res = await fetch("/api/schemas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    const data = await res.json();

    if (!res.ok) {
      return { ok: false, error: data.error ?? "Save failed" };
    }

    return { ok: true, schema: data.schema };
  } catch {
    return { ok: false, error: "Network error — please try again" };
  }
}
