import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { fetchPage } from "@/lib/url-validator/fetcher";
import { generateSchemas } from "@/lib/ai/client";
import { fixAndValidateAIOutput } from "@/lib/validation/integration";
import type { GenerateResponse, ValidatedRecommendation } from "@/lib/ai/types";

const bodySchema = z.object({
  url: z.string().url("Must be a valid URL including http:// or https://"),
});

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

  // Fetch the page HTML
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

  // Generate schemas via LLM
  let result;
  try {
    result = await generateSchemas(fetchResult.html, fetchResult.finalUrl);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Schema generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Fix and validate each recommendation's jsonld
  const validatedRecommendations: ValidatedRecommendation[] =
    result.recommendations.map((rec) => {
      try {
        const fixResult = fixAndValidateAIOutput(JSON.stringify(rec.jsonld));
        return {
          ...rec,
          jsonld: fixResult.fixed,
          validation: fixResult.validationAfter,
          fixes: fixResult.fixes,
        };
      } catch {
        return {
          ...rec,
          validation: {
            valid: false,
            errors: [
              {
                severity: "error" as const,
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
        };
      }
    });

  // Rebuild mergedJsonld from fixed recommendations
  const mergedJsonld = validatedRecommendations.map((rec) => rec.jsonld);

  const response: GenerateResponse = {
    pageType: result.pageType,
    recommendations: validatedRecommendations,
    mergedJsonld,
    notes: result.notes,
  };

  return NextResponse.json(response);
}
