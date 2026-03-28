import type { ValidationResult } from "@/lib/validation/types";

// --- Sitemap types ---

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

export interface SitemapResult {
  urls: SitemapUrl[];
  source: "sitemap.xml" | "sitemap_index" | "robots.txt" | "none";
  error?: string;
}

// --- Page processing types ---

export type PageStatus =
  | "pending"
  | "processing"
  | "valid"
  | "warnings"
  | "errors"
  | "no_schema"
  | "failed";

export type ProcessMode = "scan" | "optimize";

export interface ProcessedSchema {
  type: string;
  original: Record<string, unknown>;
  fixed: Record<string, unknown>;
  validation: ValidationResult;
  fixesApplied: string[];
}

export interface PageResult {
  url: string;
  status: PageStatus;
  originalSchemas: Record<string, unknown>[] | null;
  fixedSchemas: Record<string, unknown>[] | null;
  validationResults: {
    errorCount: number;
    warningCount: number;
    schemas: ProcessedSchema[];
  } | null;
  errorReason?: string;
}

// --- Crawl job types ---

export interface CrawlJob {
  id: string;
  site_id: string;
  status: "pending" | "running" | "completed" | "failed";
  total_urls: number;
  processed_urls: number;
  created_at: string;
  completed_at: string | null;
}

export interface CrawlStatusResponse {
  crawlId: string;
  status: CrawlJob["status"];
  totalUrls: number;
  processedUrls: number;
  results: {
    valid: number;
    warnings: number;
    errors: number;
    no_schema: number;
    failed: number;
    pending: number;
  };
}

export interface BatchResult {
  processed: number;
  remaining: number;
  crawlComplete: boolean;
  pages: PageResult[];
}
