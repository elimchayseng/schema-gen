import { fetchPage } from "./fetcher";
import { extractJsonLd } from "./extractor";
import { detectMissingOpportunities } from "./opportunities";
import { validateSchema } from "@/lib/validation";
import type { UrlScanResult, SchemaValidationSummary } from "./types";

export type { UrlScanResult, SchemaValidationSummary, MissingOpportunity } from "./types";

export async function scanUrl(url: string): Promise<UrlScanResult> {
  const scannedAt = new Date().toISOString();

  // 1. Fetch the page
  const fetchResult = await fetchPage(url);

  if (fetchResult.error || !fetchResult.html) {
    return {
      url,
      finalUrl: fetchResult.finalUrl,
      fetchStatusCode: fetchResult.statusCode,
      fetchError: fetchResult.error ?? "Empty response body",
      schemasFound: [],
      missingOpportunities: [],
      totalSchemas: 0,
      validCount: 0,
      invalidCount: 0,
      scannedAt,
    };
  }

  // 2. Extract all JSON-LD blocks
  const extracted = extractJsonLd(fetchResult.html);

  // 3. Validate each extracted schema
  const schemasFound: SchemaValidationSummary[] = extracted.map((item) => {
    if (item.parseError || item.parsed === null) {
      return {
        position: item.position,
        schemaType: null,
        raw: item.raw,
        parsed: null,
        parseError: item.parseError,
        valid: false,
        errorCount: 1,
        warningCount: 0,
        errors: [
          {
            severity: "error" as const,
            path: "",
            message: `JSON parse error: ${item.parseError}`,
            code: "INVALID_JSON" as const,
          },
        ],
        warnings: [],
        validationTimeMs: 0,
      };
    }

    const result = validateSchema(item.parsed);
    return {
      position: item.position,
      schemaType: result.summary.schemaType,
      raw: item.raw,
      parsed: item.parsed,
      valid: result.valid,
      errorCount: result.summary.errorCount,
      warningCount: result.summary.warningCount,
      errors: result.errors,
      warnings: result.warnings,
      validationTimeMs: result.summary.validationTimeMs,
    };
  });

  // 4. Detect missing opportunities
  const foundTypes = schemasFound
    .map((s) => s.schemaType)
    .filter((t): t is string => t !== null);

  const missingOpportunities = detectMissingOpportunities(
    fetchResult.html,
    fetchResult.finalUrl,
    foundTypes
  );

  const validCount = schemasFound.filter((s) => s.valid).length;

  return {
    url,
    finalUrl: fetchResult.finalUrl,
    fetchStatusCode: fetchResult.statusCode,
    schemasFound,
    missingOpportunities,
    totalSchemas: schemasFound.length,
    validCount,
    invalidCount: schemasFound.length - validCount,
    scannedAt,
  };
}
