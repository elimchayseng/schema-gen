import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchPage } from "@/lib/url-validator/fetcher";
import { generateSchemas } from "@/lib/ai/client";
import { validateAIOutput } from "@/lib/validation/integration";
import type { GenerateResponse, ValidatedRecommendation } from "@/lib/ai/types";

const bodySchema = z.object({
  url: z.string().url("Must be a valid URL including http:// or https://"),
});

export async function POST(request: Request) {
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

  // Validate each recommendation's jsonld
  const validatedRecommendations: ValidatedRecommendation[] =
    result.recommendations.map((rec) => {
      const validation = validateAIOutput(JSON.stringify(rec.jsonld));
      return { ...rec, validation };
    });

  const response: GenerateResponse = {
    pageType: result.pageType,
    recommendations: validatedRecommendations,
    mergedJsonld: result.mergedJsonld,
    notes: result.notes,
  };

  return NextResponse.json(response);
}
