import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { fetchPage } from "@/lib/url-validator/fetcher";
import { extractJsonLd } from "@/lib/url-validator/extractor";
import { detectMissingOpportunities } from "@/lib/url-validator/opportunities";
import { generateSchemas } from "@/lib/ai/client";
import { fixAndValidateAIOutputWithContext } from "@/lib/validation/integration";
import { fixSchema } from "@/lib/validation/fixer";
import { validateSchema } from "@/lib/validation/engine";
import { schemaDefinitions } from "@/lib/validation/schema-definitions";
import type { ValidatedRecommendation } from "@/lib/ai/types";
import type { ValidationIssue } from "@/lib/validation/types";
import type {
  SchemaComparison,
  ResolvedIssue,
  OptimizeResponse,
} from "@/lib/optimizer/types";

const bodySchema = z.object({
  url: z.string().url("Must be a valid URL including http:// or https://"),
});

/**
 * Compute which errors from the original schema were resolved,
 * by comparing original errors against a post-fix/post-generate validation.
 */
function computeResolvedIssues(
  originalErrors: ValidationIssue[],
  afterErrors: ValidationIssue[],
  resolution: "auto_fixed" | "ai_generated"
): ResolvedIssue[] {
  const resolved: ResolvedIssue[] = [];

  for (const origErr of originalErrors) {
    // Check if any error with same code+path still exists
    const stillExists = afterErrors.some(
      (e) => e.code === origErr.code && e.path === origErr.path
    );

    if (!stillExists) {
      resolved.push({
        originalError: origErr,
        resolution,
        description: describeResolution(origErr),
      });
    }
  }

  return resolved;
}

function describeResolution(issue: ValidationIssue): string {
  switch (issue.code) {
    case "MISSING_CONTEXT":
      return "Added missing @context";
    case "INVALID_CONTEXT":
      return "Fixed @context to https://schema.org";
    case "MISSING_REQUIRED":
      return `Added missing '${issue.path}' property`;
    case "MISSING_RECOMMENDED":
      return `Added recommended '${issue.path}' property`;
    case "ENUM_FORMAT":
      return `Fixed enum format at '${issue.path}'`;
    case "SUBOPTIMAL_TYPE":
      return `Expanded '${issue.path}' to proper object type`;
    case "INVALID_PROPERTY_PLACEMENT":
      return `Fixed property placement at '${issue.path}'`;
    default:
      return issue.suggestion ?? `Resolved: ${issue.message}`;
  }
}

export async function POST(request: Request) {
  // Auth check
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

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 }
    );
  }

  const { url } = parsed.data;

  // Fetch the page HTML (single fetch, reused for both pipelines)
  const fetchResult = await fetchPage(url);
  if (fetchResult.error) {
    return NextResponse.json(
      { error: `Failed to fetch page: ${fetchResult.error}` },
      { status: 502 }
    );
  }

  if (!fetchResult.html) {
    return NextResponse.json(
      { error: "Page returned empty content" },
      { status: 502 }
    );
  }

  const html = fetchResult.html;
  const finalUrl = fetchResult.finalUrl;

  // Pipeline A: Extract existing schemas and auto-fix
  const extracted = extractJsonLd(html);
  const existingSchemas = extracted
    .filter((e) => !e.parseError && e.parsed !== null)
    .map((e) => ({
      raw: e.raw,
      parsed: e.parsed as Record<string, unknown>,
      schemaType: String(
        (e.parsed as Record<string, unknown>)["@type"] ?? "Unknown"
      ),
      validation: validateSchema(e.parsed),
      fixResult: fixSchema(e.parsed as Record<string, unknown>),
    }));

  // Pipeline B: Generate schemas via LLM
  let llmResult: Awaited<ReturnType<typeof generateSchemas>> | null = null;
  let llmError = false;
  try {
    llmResult = await generateSchemas(html, finalUrl);
  } catch {
    llmError = true;
  }

  // Fix and validate LLM output (filter unsupported types first)
  const validatedRecs: ValidatedRecommendation[] = [];
  if (llmResult) {
    // Safety net: strip recommendations with unsupported @type
    llmResult.recommendations = llmResult.recommendations.filter((rec) => {
      const type = rec.jsonld?.["@type"];
      if (typeof type === "string" && !schemaDefinitions[type]) {
        llmResult!.notes.push(
          `Filtered unsupported schema type "${type}" from recommendations.`
        );
        return false;
      }
      return true;
    });

    for (const rec of llmResult.recommendations) {
      try {
        const fixResult = fixAndValidateAIOutputWithContext(
          JSON.stringify(rec.jsonld),
          { pageUrl: finalUrl }
        );
        validatedRecs.push({
          ...rec,
          jsonld: fixResult.fixed,
          validation: fixResult.validationAfter,
          fixes: fixResult.fixes,
        });
      } catch {
        validatedRecs.push({
          ...rec,
          validation: {
            valid: false,
            errors: [
              {
                severity: "error",
                path: "",
                message: "Auto-fix failed for this recommendation",
                code: "INVALID_JSON",
              },
            ],
            warnings: [],
            summary: {
              errorCount: 1,
              warningCount: 0,
              schemaType: rec.type,
              validationTimeMs: 0,
            },
          },
          fixes: [],
        });
      }
    }
  }

  // Match existing schemas to LLM recommendations by @type
  const matchedLLMIndexes = new Set<number>();
  const comparisons: SchemaComparison[] = [];

  for (const existing of existingSchemas) {
    // Find matching LLM recommendation by type
    const llmIndex = validatedRecs.findIndex(
      (rec, idx) =>
        !matchedLLMIndexes.has(idx) && rec.type === existing.schemaType
    );

    const matchedRec = llmIndex >= 0 ? validatedRecs[llmIndex] : null;
    if (llmIndex >= 0) matchedLLMIndexes.add(llmIndex);

    const originalErrors = [
      ...existing.validation.errors,
      ...existing.validation.warnings,
    ];

    // Box 2: Auto-fixed
    const fixerResolved = computeResolvedIssues(
      originalErrors,
      [
        ...existing.fixResult.validationAfter.errors,
        ...existing.fixResult.validationAfter.warnings,
      ],
      "auto_fixed"
    );

    const remainingAfterFix = [
      ...existing.fixResult.validationAfter.errors,
      ...existing.fixResult.validationAfter.warnings,
    ].filter((e) => e.severity === "error");

    // Box 3: AI-generated resolved issues
    let generatedWithResolved = null;
    if (matchedRec) {
      const aiResolved = computeResolvedIssues(
        originalErrors,
        [...matchedRec.validation.errors, ...matchedRec.validation.warnings],
        "ai_generated"
      );

      // Don't double-count: mark issues already fixed by auto-fixer
      const fixerResolvedKeys = new Set(
        fixerResolved.map(
          (r) => `${r.originalError.code}:${r.originalError.path}`
        )
      );
      const aiOnlyResolved = aiResolved.filter(
        (r) =>
          !fixerResolvedKeys.has(
            `${r.originalError.code}:${r.originalError.path}`
          )
      );

      // Combine: fixer resolved + AI-only resolved
      const allResolved = [
        ...fixerResolved.map((r) => ({ ...r, resolution: "auto_fixed" as const })),
        ...aiOnlyResolved.map((r) => ({
          ...r,
          resolution: "ai_generated" as const,
        })),
      ];

      generatedWithResolved = {
        ...matchedRec,
        resolvedFromOriginal: allResolved,
      };
    }

    comparisons.push({
      schemaType: existing.schemaType,
      source: matchedRec ? "both" : "existing",
      existing: {
        schema: existing.parsed,
        validation: existing.validation,
        raw: existing.raw,
      },
      fixed:
        existing.fixResult.fixes.length > 0
          ? {
              schema: existing.fixResult.fixed,
              validation: existing.fixResult.validationAfter,
              fixesApplied: existing.fixResult.fixes,
              resolvedFromOriginal: fixerResolved,
              remainingErrors: remainingAfterFix,
            }
          : null,
      generated: generatedWithResolved,
    });
  }

  // Unmatched LLM recommendations → newRecommendations
  const newRecommendations = validatedRecs.filter(
    (_, idx) => !matchedLLMIndexes.has(idx)
  );

  // Detect missing opportunities
  const foundTypes = [
    ...existingSchemas.map((s) => s.schemaType),
    ...validatedRecs.map((r) => r.type),
  ];
  const missingOpportunities = detectMissingOpportunities(
    html,
    finalUrl,
    foundTypes
  );

  const notes: string[] = llmResult?.notes ?? [];
  if (llmError) {
    notes.unshift(
      "AI generation failed — showing scan and auto-fix results only."
    );
  }

  const response: OptimizeResponse = {
    url,
    finalUrl,
    fetchStatusCode: fetchResult.statusCode,
    pageType: llmResult?.pageType ?? "unknown",
    comparisons,
    newRecommendations,
    missingOpportunities,
    notes,
  };

  return NextResponse.json(response);
}
