/**
 * Shared page processing pipeline. The agent's per-page perceive/fix primitive
 * (used by lib/agent/executor and run), covering both scan and fix modes.
 *
 * Two modes:
 * - "scan": extract → validate → fix. No LLM calls. Fast (~3-6s per page).
 * - "optimize": extract → validate → fix → AI generate → refine. Slow (~10-30s).
 */

import { fetchPage } from "@/lib/url-validator/fetcher";
import { extractJsonLd } from "@/lib/url-validator/extractor";
import { detectMissingOpportunities } from "@/lib/url-validator/opportunities";
import { validateSchema } from "@/lib/validation/engine";
import { fixSchema } from "@/lib/validation/fixer";
import { generateSchemas } from "@/lib/ai/client";
import { refineAllRecommendations } from "@/lib/ai/refinement";
import { schemaDefinitions } from "@/lib/validation/schema-definitions";
import type { ValidationResult } from "@/lib/validation/types";
import type { ExtractedJsonLd } from "@/lib/url-validator/types";
import type { ProcessMode, PageResult, PageStatus, ProcessedSchema } from "./types";

export type ProgressStep =
  | "fetching"
  | "extracting"
  | "validating"
  | "ai_generating"
  | "refining"
  | "saving";

export type ProgressCallback = (step: ProgressStep, detail?: string) => void;

export interface ProcessPageOptions {
  /**
   * Extra request headers forwarded to the page fetch — e.g. a `Cookie` carrying the
   * `storefront_digest` for a password-protected Shopify storefront, so the agent can
   * perceive a gated dev store through the password wall (same cookie L4 verify uses).
   */
  fetchHeaders?: Record<string, string>;
  /**
   * Schema types this page MUST end up with (issue #28: the agent's per-page-type
   * required set, e.g. ["Product","BreadcrumbList"]). In optimize mode this (a) is
   * passed to the LLM so generation targets exactly these types, (b) triggers AI
   * generation even on an error-free page when one of them is missing, and (c)
   * lets a generated block of a missing required type be ADDED alongside existing
   * schemas. Omitted (every pre-#28 caller): behavior is byte-identical to before.
   */
  requiredTypes?: string[];
}

const PAGE_TIMEOUT = 15_000; // 15s per page to prevent one slow page from blocking the batch

/**
 * Marker type for a JSON-LD block that exists on the page but could not be
 * parsed even after the extractor's repair pipeline. It is real, live, broken
 * structured data that Google sees — an error state to fix or override, NEVER
 * "schema missing" (treating it as missing is what generated duplicate blocks
 * on garnerandtow.com).
 */
const UNPARSEABLE_TYPE = "InvalidJSON";

function unparseableSchemaEntry(item: ExtractedJsonLd): ProcessedSchema {
  const snippet = item.raw.trim().slice(0, 500);
  const validation: ValidationResult = {
    valid: false,
    errors: [
      {
        severity: "error",
        path: "$",
        message: `JSON-LD block could not be parsed: ${item.parseError ?? "Invalid JSON"}. This broken block is live on the page — invalid schema present, not missing.`,
        code: "INVALID_JSON",
        actualValue: snippet,
      },
    ],
    warnings: [],
    summary: {
      errorCount: 1,
      warningCount: 0,
      schemaType: null,
      validationTimeMs: 0,
    },
  };
  return {
    type: UNPARSEABLE_TYPE,
    original: { raw: snippet },
    fixed: { raw: snippet },
    validation,
    fixesApplied: [],
  };
}

/**
 * Process a single page: fetch, extract JSON-LD, validate, and optionally AI-generate.
 * Optional onProgress callback fires at each stage for real-time UI updates.
 */
export async function processPage(
  url: string,
  mode: ProcessMode,
  onProgress?: ProgressCallback,
  opts: ProcessPageOptions = {}
): Promise<PageResult> {
  // Fetch page HTML with timeout
  onProgress?.("fetching");
  let fetchResult;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT);
    fetchResult = await fetchPage(
      url,
      opts.fetchHeaders ? { headers: opts.fetchHeaders } : {}
    );
    clearTimeout(timeout);
  } catch (err) {
    return {
      url,
      status: "failed",
      originalSchemas: null,
      fixedSchemas: null,
      validationResults: null,
      errorReason: err instanceof Error ? err.message : "Fetch failed",
    };
  }

  if (fetchResult.error || !fetchResult.html) {
    return {
      url,
      status: "failed",
      originalSchemas: null,
      fixedSchemas: null,
      validationResults: null,
      errorReason: fetchResult.error ?? "Empty response body",
    };
  }

  const html = fetchResult.html;
  const finalUrl = fetchResult.finalUrl;

  // Extract JSON-LD blocks
  onProgress?.("extracting");
  const extracted = extractJsonLd(html);
  const validParsed = extracted.filter((e) => !e.parseError && e.parsed !== null);
  const unparseable = extracted.filter((e) => e.parseError || e.parsed === null);

  // No parseable schemas found
  if (validParsed.length === 0) {
    // Unparseable blocks present: the page HAS schema — it is broken, not missing.
    // Never fall through to "no_schema" (and never AI-generate a duplicate block
    // alongside the broken one); surface it as an error state to fix/override.
    if (unparseable.length > 0) {
      return {
        url,
        status: "errors",
        originalSchemas: null,
        fixedSchemas: null,
        validationResults: {
          errorCount: unparseable.length,
          warningCount: 0,
          schemas: unparseable.map(unparseableSchemaEntry),
        },
        errorReason: `${unparseable.length} JSON-LD block(s) on the page are invalid JSON and could not be parsed`,
        renderedBlocks: extracted,
      };
    }

    if (mode === "optimize") {
      // AI generate schemas for this page
      return {
        ...(await generateForPage(url, finalUrl, html, onProgress, opts.requiredTypes)),
        renderedBlocks: extracted,
      };
    }
    return {
      url,
      status: "no_schema",
      originalSchemas: null,
      fixedSchemas: null,
      validationResults: null,
      renderedBlocks: extracted,
    };
  }

  // Validate and fix each schema
  onProgress?.("validating");
  const processedSchemas: ProcessedSchema[] = [];
  const originals: Record<string, unknown>[] = [];
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const item of validParsed) {
    const parsed = item.parsed as Record<string, unknown>;
    const validation = validateSchema(parsed);
    const fixResult = fixSchema(parsed);

    const schemaType = String(parsed["@type"] ?? "Unknown");
    const fixesApplied = fixResult.fixes.map((f) => f.description);

    processedSchemas.push({
      type: schemaType,
      original: parsed,
      fixed: fixResult.fixed,
      validation: fixResult.validationAfter,
      fixesApplied,
    });

    originals.push(parsed);
    totalErrors += fixResult.validationAfter.errors.length;
    totalWarnings += fixResult.validationAfter.warnings.length;
  }

  // Unparseable blocks alongside valid ones still count as live invalid schema —
  // they force the page into an error state so they get fixed, not ignored.
  for (const item of unparseable) {
    processedSchemas.push(unparseableSchemaEntry(item));
    totalErrors += 1;
  }

  // Determine status based on remaining issues after auto-fix
  let status: PageStatus;
  if (totalErrors > 0) {
    status = "errors";
  } else if (totalWarnings > 0) {
    status = "warnings";
  } else {
    status = "valid";
  }

  // A required type with no live block (e.g. a homepage carrying WebSite but no
  // Organization) must also trigger generation — the page can be error-free yet
  // still short of the goal. Empty/absent requiredTypes leaves this empty.
  const missingRequired = (opts.requiredTypes ?? []).filter(
    (t) => !processedSchemas.some((s) => s.type === t)
  );

  // In optimize mode, also run AI generation to improve schemas
  if (mode === "optimize" && (totalErrors > 0 || totalWarnings > 0 || missingRequired.length > 0)) {
    try {
      onProgress?.("ai_generating");
      const aiResult = await generateAndRefine(finalUrl, html, onProgress, opts.requiredTypes);
      if (aiResult) {
        // Merge AI-generated fixes into the result
        for (const rec of aiResult) {
          const existingIdx = processedSchemas.findIndex((s) => s.type === rec.type);
          if (existingIdx >= 0) {
            processedSchemas[existingIdx].fixed = rec.jsonld;
            processedSchemas[existingIdx].validation = rec.validation;
            processedSchemas[existingIdx].fixesApplied.push("AI-refined");
          } else if (missingRequired.includes(rec.type)) {
            // ADD a generated block only for a missing REQUIRED type — novel
            // unsolicited types are still dropped, exactly as before.
            processedSchemas.push({
              type: rec.type,
              original: rec.jsonld,
              fixed: rec.jsonld,
              validation: rec.validation,
              fixesApplied: ["AI-generated"],
            });
          }
        }
        // Recalculate status
        const newErrors = processedSchemas.reduce(
          (sum, s) => sum + s.validation.errors.length, 0
        );
        const newWarnings = processedSchemas.reduce(
          (sum, s) => sum + s.validation.warnings.length, 0
        );
        if (newErrors > 0) status = "errors";
        else if (newWarnings > 0) status = "warnings";
        else status = "valid";
      }
    } catch {
      // AI failure is non-fatal, keep auto-fix results
    }
  }

  // fixedSchemas MUST come from processedSchemas, not a separate pre-AI array: the AI
  // refinement above merges its result into processedSchemas[i].fixed. The agent's executor
  // gates result.fixedSchemas, so returning the pre-AI auto-fix here would make the agent
  // judge (and stage) the weaker schema and discard the AI's work on already-has-schema pages.
  // Unparseable placeholders are excluded — their `fixed` is a raw snippet, not a schema,
  // and must never be staged.
  const stageable = processedSchemas.filter((s) => s.type !== UNPARSEABLE_TYPE);
  return {
    url,
    status,
    originalSchemas: originals,
    fixedSchemas: stageable.length > 0 ? stageable.map((s) => s.fixed) : null,
    validationResults: {
      errorCount: totalErrors,
      warningCount: totalWarnings,
      schemas: processedSchemas,
    },
    renderedBlocks: extracted,
  };
}

/**
 * Generate schemas via AI for a page with no existing schemas.
 */
async function generateForPage(
  url: string,
  finalUrl: string,
  html: string,
  onProgress?: ProgressCallback,
  requiredTypes?: string[]
): Promise<PageResult> {
  try {
    onProgress?.("ai_generating");
    const recs = await generateAndRefine(finalUrl, html, onProgress, requiredTypes);
    if (!recs || recs.length === 0) {
      return {
        url,
        status: "no_schema",
        originalSchemas: null,
        fixedSchemas: null,
        validationResults: null,
      };
    }

    const schemas = recs.map((r) => r.jsonld);
    const processedSchemas: ProcessedSchema[] = recs.map((r) => ({
      type: r.type,
      original: r.jsonld,
      fixed: r.jsonld,
      validation: r.validation,
      fixesApplied: ["AI-generated"],
    }));

    const totalErrors = processedSchemas.reduce(
      (sum, s) => sum + s.validation.errors.length, 0
    );
    const totalWarnings = processedSchemas.reduce(
      (sum, s) => sum + s.validation.warnings.length, 0
    );

    return {
      url,
      status: totalErrors > 0 ? "errors" : totalWarnings > 0 ? "warnings" : "valid",
      originalSchemas: null,
      fixedSchemas: schemas,
      validationResults: {
        errorCount: totalErrors,
        warningCount: totalWarnings,
        schemas: processedSchemas,
      },
    };
  } catch (err) {
    return {
      url,
      status: "no_schema",
      originalSchemas: null,
      fixedSchemas: null,
      validationResults: null,
      errorReason: `AI generation failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

/**
 * Run the AI generation + refinement pipeline.
 * Returns validated recommendations or null on failure.
 */
async function generateAndRefine(
  finalUrl: string,
  html: string,
  onProgress?: ProgressCallback,
  requiredTypes?: string[]
) {
  const llmResult = await generateSchemas(html, finalUrl, requiredTypes);
  if (!llmResult) return null;

  // Filter unsupported types
  llmResult.recommendations = llmResult.recommendations.filter((rec) => {
    const type = rec.jsonld?.["@type"];
    return !(typeof type === "string" && !schemaDefinitions[type]);
  });

  if (llmResult.recommendations.length === 0) return null;

  onProgress?.("refining", `${llmResult.recommendations.length} schemas`);

  const refined = await refineAllRecommendations(
    llmResult.recommendations,
    finalUrl,
    html
  );

  return refined;
}
