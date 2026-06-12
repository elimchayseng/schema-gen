import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { validateSchema } from "@/lib/validation";
import type { ValidationResult } from "@/lib/validation";
import {
  applyOverrides,
  proposeOverrideEdits,
  saveOverride,
} from "@/lib/agent/overrides";

/**
 * POST /api/agent/overrides/chat — conversational schema tweak (issue #29).
 *
 * Body: { siteId, url, schemaType, currentJsonld, message }
 *
 * Flow (the LLM proposes; lib/validation disposes — the LLM is never a gate):
 *   1. LLM translates the merchant's instruction into targeted
 *      {fieldPath, value, reason} edits (never a whole-document rewrite).
 *   2. The edits are applied DETERMINISTICALLY via applyOverrides semantics.
 *      Any edit that fails to apply (bad path) rejects the whole set — we
 *      never persist a half-understood instruction.
 *   3. validateSchema runs on the edited node. An edit set that makes the
 *      schema invalid (or adds errors to an already-imperfect one) → 400.
 *   4. Only then is each edit persisted as a sticky override (source 'chat'),
 *      so every future agent re-run merges it back on top of fresh LLM output.
 *
 * Returns { updatedJsonld, edits, validation }.
 */

const bodySchema = z.object({
  siteId: z.string().min(1),
  url: z.string().min(1),
  schemaType: z.string().min(1),
  currentJsonld: z.unknown(),
  message: z.string().min(1),
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pull the node we're editing (matched by @type) out of a JSON-LD document. */
function findNode(doc: unknown, schemaType: string): unknown {
  const matches = (n: unknown) => {
    if (!isPlainObject(n)) return false;
    const t = n["@type"];
    return typeof t === "string"
      ? t === schemaType
      : Array.isArray(t) && t.includes(schemaType);
  };
  if (Array.isArray(doc)) return doc.find(matches) ?? null;
  if (isPlainObject(doc) && Array.isArray(doc["@graph"])) {
    if (matches(doc)) return doc;
    return (doc["@graph"] as unknown[]).find(matches) ?? null;
  }
  return matches(doc) ? doc : null;
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: `Invalid body: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim(),
      },
      { status: 400 }
    );
  }
  const { siteId, url, schemaType, currentJsonld, message } = parsed.data;

  // Ownership: the user-scoped client only sees the user's own sites.
  const { data: site } = await supabase
    .from("sites")
    .select("id")
    .eq("id", siteId)
    .eq("user_id", user.id)
    .single();
  if (!site) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  const targetBefore = findNode(currentJsonld, schemaType);
  if (!targetBefore) {
    return NextResponse.json(
      { error: `currentJsonld has no node with @type "${schemaType}"` },
      { status: 400 }
    );
  }

  // 1. LLM proposes targeted edits.
  let edits;
  try {
    edits = await proposeOverrideEdits({ currentJsonld, schemaType, url, message });
  } catch (e) {
    // Raw provider errors stay server-side (matches the provision route's error path).
    console.error("[agent/overrides/chat] LLM proposal failed:", e);
    return NextResponse.json(
      { error: "The AI service couldn't process that instruction. Try again." },
      { status: 502 }
    );
  }

  if (edits.length === 0) {
    return NextResponse.json(
      {
        error:
          "The agent couldn't map that instruction to any schema field. Try naming the value to change, e.g. \"the brand is Garner & Tow\".",
      },
      { status: 400 }
    );
  }

  // 2. Apply deterministically. Any unapplicable edit rejects the whole set.
  const { result: updatedJsonld, applied, conflicts } = applyOverrides(
    currentJsonld,
    edits.map((e) => ({ schemaType, fieldPath: e.fieldPath, value: e.value }))
  );
  if (conflicts.length > 0) {
    return NextResponse.json(
      {
        error: "Some proposed edits don't fit the current schema; nothing was saved.",
        conflicts,
      },
      { status: 400 }
    );
  }

  // 3. lib/validation is THE gate. Reject an edit set that makes the schema
  //    invalid — or adds errors to a schema that already had some (a merchant
  //    correction on an imperfect schema is allowed as long as it doesn't
  //    make things worse).
  const before: ValidationResult = validateSchema(targetBefore);
  const after: ValidationResult = validateSchema(findNode(updatedJsonld, schemaType));
  const madeInvalid =
    (before.valid && !after.valid) ||
    after.errors.length > before.errors.length;
  if (madeInvalid) {
    return NextResponse.json(
      {
        error:
          "Those changes would make the schema invalid, so they were not saved.",
        validation: after,
        edits,
      },
      { status: 400 }
    );
  }

  // 4. Persist each edit as a sticky override (source 'chat').
  const saved = [];
  try {
    for (const a of applied) {
      saved.push(
        await saveOverride({
          siteId,
          url,
          schemaType,
          fieldPath: a.fieldPath,
          value: a.value,
          source: "chat",
        })
      );
    }
  } catch (e) {
    console.error("[agent/overrides/chat] save failed:", e);
    return NextResponse.json(
      { error: "Failed to save corrections" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    updatedJsonld,
    edits,
    overrides: saved,
    validation: after,
  });
}
