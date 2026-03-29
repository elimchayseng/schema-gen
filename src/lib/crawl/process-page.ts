/**
 * Shared page processing pipeline.
 *
 * Extracted from /api/optimize to be reused by both single-page optimize
 * and site-wide crawl batch processing.
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
import type { ProcessMode, PageResult, PageStatus, ProcessedSchema } from "./types";

export type ProgressStep =
  | "fetching"
  | "extracting"
  | "validating"
  | "ai_generating"
  | "refining"
  | "saving";

export type ProgressCallback = (step: ProgressStep, detail?: string) => void;

const PAGE_TIMEOUT = 15_000; // 15s per page to prevent one slow page from blocking the batch

/**
 * Process a single page: fetch, extract JSON-LD, validate, and optionally AI-generate.
 * Optional onProgress callback fires at each stage for real-time UI updates.
 */
export async function processPage(
  url: string,
  mode: ProcessMode,
  onProgress?: ProgressCallback
): Promise<PageResult> {
  // Fetch page HTML with timeout
  onProgress?.("fetching");
  let fetchResult;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT);
    fetchResult = await fetchPage(url);
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

  // No schemas found
  if (validParsed.length === 0) {
    if (mode === "optimize") {
      // AI generate schemas for this page
      return await generateForPage(url, finalUrl, html, onProgress);
    }
    return {
      url,
      status: "no_schema",
      originalSchemas: null,
      fixedSchemas: null,
      validationResults: null,
    };
  }

  // Validate and fix each schema
  onProgress?.("validating");
  const processedSchemas: ProcessedSchema[] = [];
  const originals: Record<string, unknown>[] = [];
  const fixed: Record<string, unknown>[] = [];
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
    fixed.push(fixResult.fixed);
    totalErrors += fixResult.validationAfter.errors.length;
    totalWarnings += fixResult.validationAfter.warnings.length;
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

  // In optimize mode, also run AI generation to improve schemas
  if (mode === "optimize" && (totalErrors > 0 || totalWarnings > 0)) {
    try {
      onProgress?.("ai_generating");
      const aiResult = await generateAndRefine(finalUrl, html, onProgress);
      if (aiResult) {
        // Merge AI-generated fixes into the result
        for (const rec of aiResult) {
          const existingIdx = processedSchemas.findIndex((s) => s.type === rec.type);
          if (existingIdx >= 0) {
            processedSchemas[existingIdx].fixed = rec.jsonld;
            processedSchemas[existingIdx].validation = rec.validation;
            processedSchemas[existingIdx].fixesApplied.push("AI-refined");
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

  return {
    url,
    status,
    originalSchemas: originals,
    fixedSchemas: fixed.length > 0 ? fixed : null,
    validationResults: {
      errorCount: totalErrors,
      warningCount: totalWarnings,
      schemas: processedSchemas,
    },
  };
}

/**
 * Generate schemas via AI for a page with no existing schemas.
 */
async function generateForPage(
  url: string,
  finalUrl: string,
  html: string,
  onProgress?: ProgressCallback
): Promise<PageResult> {
  try {
    onProgress?.("ai_generating");
    const recs = await generateAndRefine(finalUrl, html, onProgress);
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
  onProgress?: ProgressCallback
) {
  const llmResult = await generateSchemas(html, finalUrl);
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
