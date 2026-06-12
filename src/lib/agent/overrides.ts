/**
 * Merchant overrides (issue #29): sticky per-page+field corrections to
 * LLM-generated JSON-LD.
 *
 * Three layers in one module:
 *   1. applyOverrides — PURE merge of stored overrides onto a freshly generated
 *      JSON-LD document. The executor calls this AFTER LLM generation so a
 *      merchant correction always wins over a regenerate. Never throws on a bad
 *      path — it skips the override and records a conflict note instead.
 *   2. loadOverrides / saveOverride / deleteOverride — Supabase persistence via
 *      the service-role client (same idiom as audit.ts; merchant_overrides has
 *      RLS-with-no-policies, ownership is enforced in the API layer).
 *   3. proposeOverrideEdits — the LLM proposer used by the chat route. It only
 *      ever PROPOSES {fieldPath, value, reason} edits; the route deterministically
 *      applies them and lib/validation disposes. The LLM is never a quality gate.
 */
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase";

// ─── applyOverrides (pure) ──────────────────────────────────────────────────

/** The minimal shape applyOverrides needs — MerchantOverride satisfies it. */
export interface OverrideInput {
  /** @type of the JSON-LD node to target (root, array member, or @graph member). */
  schemaType: string;
  /** Dot path within that node, e.g. "brand.name", "offers.0.availability". */
  fieldPath: string;
  value: unknown;
}

export interface OverrideConflict extends OverrideInput {
  reason: string;
}

export interface ApplyOverridesResult {
  /** Deep copy of the input with applied overrides; the input is never mutated. */
  result: unknown;
  applied: OverrideInput[];
  conflicts: OverrideConflict[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Does this node's @type match the override's schemaType (string or array @type)? */
function typeMatches(node: unknown, schemaType: string): boolean {
  if (!isPlainObject(node)) return false;
  const t = node["@type"];
  if (typeof t === "string") return t === schemaType;
  if (Array.isArray(t)) return t.includes(schemaType);
  return false;
}

/**
 * Candidate top-level nodes within a JSON-LD document: a bare array's members,
 * an object's @graph members (plus the wrapper itself), or the single object.
 */
function candidateNodes(doc: unknown): unknown[] {
  if (Array.isArray(doc)) return doc;
  if (isPlainObject(doc) && Array.isArray(doc["@graph"])) {
    return [doc, ...(doc["@graph"] as unknown[])];
  }
  return [doc];
}

const NUMERIC_SEGMENT = /^\d+$/;

/**
 * Segments that would traverse or assign into the prototype chain instead of
 * plain data. fieldPath is LLM-proposed from merchant chat, so "__proto__.x"
 * would otherwise pollute Object.prototype process-wide (current["__proto__"]
 * is a plain object to isPlainObject, and the final assignment lands on it).
 */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Set `value` at `segments` within `node`. Returns null on success or a
 * human-readable conflict reason. Mutates `node` (callers pass a clone).
 *
 * Path semantics:
 * - Non-numeric segments index into plain objects; missing intermediates are
 *   created as {} (so "brand.name" works even when the LLM omitted brand).
 * - Numeric segments index into arrays and must be in bounds.
 * - A "0" intermediate segment on a plain object is treated as the object
 *   itself — JSON-LD frequently has `offers` as either an object or a
 *   one-element array, and the override must survive both shapes.
 * - Traversing through a primitive, indexing an object with a non-zero number,
 *   or any other shape mismatch is a conflict (skip, never throw).
 */
function setAtPath(
  node: Record<string, unknown>,
  segments: string[],
  value: unknown
): string | null {
  for (const seg of segments) {
    if (FORBIDDEN_SEGMENTS.has(seg)) {
      return `forbidden path segment "${seg}"`;
    }
  }

  let current: unknown = node;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const prefix = segments.slice(0, i + 1).join(".");

    if (NUMERIC_SEGMENT.test(seg)) {
      const idx = Number(seg);
      if (Array.isArray(current)) {
        if (idx >= current.length) {
          return `array index out of bounds at "${prefix}" (length ${current.length})`;
        }
        current = current[idx];
      } else if (isPlainObject(current) && idx === 0) {
        // offers.0.* tolerates offers being a single object instead of an array.
        continue;
      } else {
        return `expected an array at "${segments.slice(0, i).join(".") || "(root)"}" for index ${idx}`;
      }
    } else {
      if (!isPlainObject(current)) {
        return `cannot traverse into non-object at "${segments.slice(0, i).join(".") || "(root)"}"`;
      }
      const next = current[seg];
      if (next === undefined || next === null) {
        // Auto-create missing intermediate objects — but only when the next
        // segment is a key. We can't safely invent an array.
        if (NUMERIC_SEGMENT.test(segments[i + 1])) {
          return `missing array at "${prefix}" — cannot create one for an index path`;
        }
        const created: Record<string, unknown> = {};
        current[seg] = created;
        current = created;
      } else if (isPlainObject(next) || Array.isArray(next)) {
        current = next;
      } else {
        return `cannot traverse through primitive at "${prefix}"`;
      }
    }
  }

  const last = segments[segments.length - 1];
  if (NUMERIC_SEGMENT.test(last)) {
    const idx = Number(last);
    if (!Array.isArray(current)) {
      return `expected an array for final segment "${last}"`;
    }
    if (idx >= current.length) {
      return `array index out of bounds at "${segments.join(".")}" (length ${current.length})`;
    }
    current[idx] = value;
    return null;
  }
  if (!isPlainObject(current)) {
    return `cannot set "${last}" on a non-object`;
  }
  current[last] = value;
  return null;
}

/**
 * PURE: deep-apply override values onto a JSON-LD document (single object,
 * array of nodes, or @graph wrapper — the target node is matched by @type).
 * Returns a new document plus per-override applied/conflict bookkeeping.
 * Never throws on a bad path; idempotent (applying twice yields the same result).
 *
 * Executor contract (round 3 wiring):
 *   const { result } = applyOverrides(generated, await loadOverrides(siteId, url));
 */
export function applyOverrides(
  jsonld: unknown,
  overrides: OverrideInput[]
): ApplyOverridesResult {
  const result = structuredClone(jsonld);
  const applied: OverrideInput[] = [];
  const conflicts: OverrideConflict[] = [];

  for (const o of overrides) {
    const entry: OverrideInput = {
      schemaType: o.schemaType,
      fieldPath: o.fieldPath,
      value: o.value,
    };

    const segments = o.fieldPath.split(".").filter((s) => s.length > 0);
    if (segments.length === 0) {
      conflicts.push({ ...entry, reason: "empty field path" });
      continue;
    }

    const node = candidateNodes(result).find((n) => typeMatches(n, o.schemaType));
    if (!node) {
      conflicts.push({
        ...entry,
        reason: `no node with @type "${o.schemaType}" in the document`,
      });
      continue;
    }

    const failure = setAtPath(
      node as Record<string, unknown>,
      segments,
      // Clone the value too: a caller mutating its override list afterwards
      // must not reach into the merged document.
      structuredClone(o.value)
    );
    if (failure) {
      conflicts.push({ ...entry, reason: failure });
    } else {
      applied.push(entry);
    }
  }

  return { result, applied, conflicts };
}

// ─── Persistence (service-role, audit.ts idiom) ─────────────────────────────

export type OverrideSource = "chat" | "manual";

export interface MerchantOverride {
  id: string;
  siteId: string;
  url: string;
  schemaType: string;
  fieldPath: string;
  value: unknown;
  source: OverrideSource;
  createdAt: string;
  updatedAt: string;
}

interface OverrideRow {
  id: string;
  site_id: string;
  url: string;
  schema_type: string;
  field_path: string;
  value: unknown;
  source: OverrideSource;
  created_at: string;
  updated_at: string;
}

function rowToOverride(r: OverrideRow): MerchantOverride {
  return {
    id: r.id,
    siteId: r.site_id,
    url: r.url,
    schemaType: r.schema_type,
    fieldPath: r.field_path,
    value: r.value,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** All sticky overrides for one page, oldest first (stable apply order). */
export async function loadOverrides(
  siteId: string,
  url: string
): Promise<MerchantOverride[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("merchant_overrides")
    .select("*")
    .eq("site_id", siteId)
    .eq("url", url)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`Failed to load merchant_overrides: ${error.message}`);
  }
  return ((data ?? []) as OverrideRow[]).map(rowToOverride);
}

/**
 * Upsert one override on the (site_id, url, schema_type, field_path) unique key —
 * re-correcting the same field replaces the previous value rather than stacking.
 */
export async function saveOverride(o: {
  siteId: string;
  url: string;
  schemaType: string;
  fieldPath: string;
  value: unknown;
  source: OverrideSource;
}): Promise<MerchantOverride> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("merchant_overrides")
    .upsert(
      {
        site_id: o.siteId,
        url: o.url,
        schema_type: o.schemaType,
        field_path: o.fieldPath,
        value: o.value,
        source: o.source,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "site_id,url,schema_type,field_path" }
    )
    .select("*")
    .single();
  if (error) {
    throw new Error(`Failed to save merchant_override: ${error.message}`);
  }
  return rowToOverride(data as OverrideRow);
}

/**
 * Delete one override by id, scoped to siteId so the API layer's ownership
 * check (user owns siteId) transitively covers the row being removed.
 */
export async function deleteOverride(id: string, siteId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("merchant_overrides")
    .delete()
    .eq("id", id)
    .eq("site_id", siteId);
  if (error) {
    throw new Error(`Failed to delete merchant_override: ${error.message}`);
  }
}

/** Look up one override row (for the DELETE route's ownership check). */
export async function getOverride(id: string): Promise<MerchantOverride | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("merchant_overrides")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read merchant_override: ${error.message}`);
  }
  return data ? rowToOverride(data as OverrideRow) : null;
}

// ─── LLM edit proposer (chat route) ─────────────────────────────────────────

export interface ProposedEdit {
  fieldPath: string;
  value: unknown;
  reason: string;
}

const proposedEditSchema = z.object({
  fieldPath: z
    .string()
    .min(1)
    .refine((p) => p.split(".").every((s) => !FORBIDDEN_SEGMENTS.has(s)), {
      message: "fieldPath must not traverse the prototype chain",
    }),
  value: z.unknown(),
  reason: z.string(),
});

const editsResponseSchema = z.object({
  edits: z.array(proposedEditSchema),
});

const EDIT_SYSTEM_PROMPT = `You translate a merchant's correction into precise field edits on an existing schema.org JSON-LD document.

You will receive the current JSON-LD, its primary @type, the page URL, and the merchant's instruction.

RULES:
1. Return ONLY targeted field edits — never a whole-document rewrite.
2. fieldPath is a dot path within the node of the given @type, e.g. "description", "brand.name", "offers.0.availability". Use numeric segments only for array indices that exist in the current document.
3. Each edit's value must be the complete new value for that field (string, number, object, or array).
4. Only edit fields the merchant's instruction actually concerns. If the instruction is unclear or concerns nothing in the schema, return an empty edits array.
5. For enum values (availability, itemCondition, etc.) use the full URL form, e.g. "https://schema.org/PreOrder".
6. Keep values factual to the merchant's words — do not invent marketing copy beyond what they asked for.

STRICT OUTPUT RULES:
- Respond ONLY with a valid JSON object: {"edits": [{"fieldPath": "...", "value": <json>, "reason": "<1 sentence>"}]}
- Your entire response must be parseable by JSON.parse(). No prose, no markdown.`;

const EDIT_TIMEOUT_MS = 30_000;

/**
 * Ask the LLM to translate a merchant instruction into {fieldPath, value, reason}
 * edits against the current JSON-LD. PROPOSAL ONLY — the caller must apply the
 * edits deterministically (applyOverrides) and gate the result through
 * lib/validation before persisting or returning anything.
 */
export async function proposeOverrideEdits(args: {
  currentJsonld: unknown;
  schemaType: string;
  url: string;
  message: string;
}): Promise<ProposedEdit[]> {
  const INFERENCE_URL = process.env.HEROKU_INFERENCE_URL;
  const INFERENCE_KEY = process.env.HEROKU_INFERENCE_KEY;
  const INFERENCE_MODEL = process.env.HEROKU_INFERENCE_MODEL;
  if (!INFERENCE_URL || !INFERENCE_KEY || !INFERENCE_MODEL) {
    throw new Error(
      "Missing Heroku Inference environment variables (HEROKU_INFERENCE_URL, HEROKU_INFERENCE_KEY, HEROKU_INFERENCE_MODEL)"
    );
  }

  const userContent = `Page URL: ${args.url}
Primary @type: ${args.schemaType}

Current JSON-LD:
${JSON.stringify(args.currentJsonld, null, 2)}

Merchant instruction:
${args.message}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EDIT_TIMEOUT_MS);

  try {
    const endpoint = INFERENCE_URL.replace(/\/+$/, "") + "/v1/chat/completions";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INFERENCE_KEY}`,
      },
      body: JSON.stringify({
        model: INFERENCE_MODEL,
        messages: [
          { role: "system", content: EDIT_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 2048,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Override edit API returned ${response.status}: ${errorText.slice(0, 300)}`
      );
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    let content = payload.choices?.[0]?.message?.content?.trim() ?? "";
    if (!content) {
      throw new Error("Override edit LLM returned an empty response");
    }
    if (content.startsWith("```")) {
      content = content
        .replace(/^```(?:json)?\s*\n?/, "")
        .replace(/\n?```\s*$/, "");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("Override edit LLM response is not valid JSON");
    }

    const validated = editsResponseSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `Override edit LLM response does not match expected shape: ${validated.error.issues[0]?.message ?? "unknown"}`
      );
    }

    return validated.data.edits.map((e) => ({
      fieldPath: e.fieldPath,
      value: e.value ?? null,
      reason: e.reason,
    }));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Override edit request timed out after ${EDIT_TIMEOUT_MS / 1000} seconds`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
