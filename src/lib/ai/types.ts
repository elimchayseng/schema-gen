import type { ValidationResult, FixApplied } from "@/lib/validation/types";

/** A single schema recommendation from the LLM */
export interface SchemaRecommendation {
  /** schema.org type name, e.g. "Product" */
  type: string;
  /** 1 = primary/required, 2 = strongly recommended, 3 = optional */
  priority: 1 | 2 | 3;
  /** Short explanation of why this type is recommended */
  rationale: string;
  /** Complete JSON-LD object */
  jsonld: Record<string, unknown>;
  /** Shopify .liquid placement instructions */
  shopifyInstructions: string;
}

/** Full result returned by the generator */
export interface GeneratorResult {
  /** Inferred page type (product, homepage, blog_post, etc.) */
  pageType: string;
  /** Ordered list of schema recommendations */
  recommendations: SchemaRecommendation[];
  /** All jsonld objects merged, ready to embed */
  mergedJsonld: Record<string, unknown>[];
  /** Caveats or data gaps the user should know about */
  notes: string[];
}

/** A recommendation enriched with validation results for the UI */
export interface ValidatedRecommendation extends SchemaRecommendation {
  validation: ValidationResult;
  fixes: FixApplied[];
}

/** Full API response from /api/ai/generate */
export interface GenerateResponse {
  pageType: string;
  recommendations: ValidatedRecommendation[];
  mergedJsonld: Record<string, unknown>[];
  notes: string[];
}

/** OpenAI-compatible message for LLM requests */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** OpenAI-compatible chat completion response */
export interface LLMResponse {
  id: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
