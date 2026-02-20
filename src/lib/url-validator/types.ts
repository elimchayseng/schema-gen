import type { ValidationIssue } from "@/lib/validation/types";

export interface FetchResult {
  html: string;
  statusCode: number;
  finalUrl: string;
  error?: string;
}

export interface ExtractedJsonLd {
  raw: string;
  parsed: unknown;
  parseError?: string;
  position: number;
}

export interface SchemaValidationSummary {
  position: number;
  schemaType: string | null;
  raw: string;
  parsed: unknown;
  parseError?: string;
  valid: boolean;
  errorCount: number;
  warningCount: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  validationTimeMs: number;
}

export interface MissingOpportunity {
  schemaType: string;
  reason: string;
  confidence: "high" | "medium" | "low";
}

export interface UrlScanResult {
  url: string;
  finalUrl: string;
  fetchStatusCode: number;
  fetchError?: string;
  schemasFound: SchemaValidationSummary[];
  missingOpportunities: MissingOpportunity[];
  totalSchemas: number;
  validCount: number;
  invalidCount: number;
  scannedAt: string;
}
