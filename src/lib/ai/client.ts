import * as cheerio from "cheerio";
import { z } from "zod";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import type { GeneratorResult, LLMMessage } from "./types";

// ─── Logging ─────────────────────────────────────────────────────────────────

type LogLevel = "debug" | "info" | "warn" | "error";

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: "ai-client",
    message,
    ...data,
  };
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(JSON.stringify(entry));
}

// ─── Environment ────────────────────────────────────────────────────────────

const INFERENCE_URL = process.env.HEROKU_INFERENCE_URL;
const INFERENCE_KEY = process.env.HEROKU_INFERENCE_KEY;
const INFERENCE_MODEL = process.env.HEROKU_INFERENCE_MODEL;

const MAX_HTML_CHARS = 30_000;
const TIMEOUT_MS = 120_000;

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a structured data specialist working inside a schema markup generation tool
built for ecommerce SEO consultants. Your job is to analyze the HTML content of an
ecommerce page and return a complete, valid set of schema.org JSON-LD recommendations
that are appropriate for that page.

You will be given:
- The URL of the specific page being analyzed
- The HTML content of that page (cleaned of scripts/styles)

YOUR RESPONSIBILITIES:

1. Identify which schema.org types are appropriate for this page based on its content
   and URL structure. Common page types include: product pages, collection/category
   pages, blog posts, homepage, about page, contact page, and FAQ pages.

2. Extract all relevant data from the HTML to populate schema properties. Infer
   values when they are clearly implied by the content.

3. Return a separate JSON-LD block for each recommended schema type. Each block
   must be complete and self-contained.

4. Only include properties you can populate with real or strongly inferred data.
   Do not include empty properties or placeholder values.

5. Every property must be valid for its schema.org @type. Never place a property
   on the wrong object type. For example: 'color', 'material', 'sku', and 'brand'
   belong on Product — never on Offer. 'price' and 'priceCurrency' belong on
   Offer — never on Product.

6. Nested objects must always include their own @type declaration.

7. Use https://schema.org/ as the @context for all blocks.

8. For enum values (availability, itemCondition, etc.), always use the full URL
   format: https://schema.org/InStock — never shorthand like 'InStock'.

9. Currency codes must be valid ISO 4217 3-letter codes (e.g., USD, GBP, EUR).

10. All URLs must be absolute (include https://).

11. Dates must follow ISO 8601 format (YYYY-MM-DD).

12. For each recommendation, include a "shopifyInstructions" field with specific
    Shopify .liquid placement guidance. For example:
    - Product schema → "Add to sections/product-template.liquid or templates/product.liquid, inside the main product block."
    - Organization/WebSite → "Add to layout/theme.liquid just before the closing </head> tag so it appears on every page."
    - BreadcrumbList → "Add to snippets/breadcrumb.liquid or the relevant section file."
    - Article/BlogPosting → "Add to templates/article.liquid or sections/article-template.liquid."
    Be specific about which Shopify template file and where in the file the schema should go.

STRICT OUTPUT RULES:

- Respond ONLY with a valid JSON object. No prose, no markdown, no explanation
  outside the JSON structure.
- Your entire response must be parseable by JSON.parse().
- Use the exact output structure defined below. Do not add or remove top-level keys.
- The 'rationale' field for each recommendation must be 1-2 sentences maximum.
- If you cannot identify enough data to generate a meaningful schema block for a
  type, omit that type entirely rather than returning a sparse or placeholder block.

OUTPUT STRUCTURE:

{
  "pageType": "<inferred page type, e.g. product, homepage, blog_post, faq, collection, about, contact>",
  "recommendations": [
    {
      "type": "<schema.org type name, e.g. Product>",
      "priority": <1 = primary/required for this page, 2 = strongly recommended, 3 = optional enhancement>,
      "rationale": "<1-2 sentence explanation of why this type is recommended for this page>",
      "jsonld": { <complete, valid JSON-LD object for this type> },
      "shopifyInstructions": "<specific Shopify .liquid placement guidance>"
    }
  ],
  "mergedJsonld": [ <array of all jsonld objects above, ready to embed as a JSON-LD script block> ],
  "notes": [ "<any important caveats or data gaps the user should be aware of>" ]
}

SCHEMA TYPES YOU MAY RECOMMEND (use only what is appropriate for the page):
Product, Offer, Organization, LocalBusiness, WebSite, FAQPage, Question,
Article, BlogPosting, BreadcrumbList, ListItem, AggregateRating, Review,
CollectionPage, ItemList, AboutPage, ContactPage, PostalAddress, Brand

Do not recommend schema types outside this list.`;

// ─── Response validation schema ─────────────────────────────────────────────

const recommendationSchema = z.object({
  type: z.string(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  rationale: z.string(),
  jsonld: z.record(z.string(), z.unknown()),
  shopifyInstructions: z.string(),
});

const generatorResultSchema = z.object({
  pageType: z.string(),
  recommendations: z.array(recommendationSchema),
  mergedJsonld: z.array(z.record(z.string(), z.unknown())),
  notes: z.array(z.string()),
});

// ─── HTML preprocessing ─────────────────────────────────────────────────────

export function preprocessHtml(html: string): string {
  const $ = cheerio.load(html);

  // Remove elements that add noise without useful schema data
  $("script").remove();
  $("style").remove();
  $("svg").remove();
  $("noscript").remove();
  $("link").remove();
  $("meta[name='theme-color']").remove();
  $("meta[name='viewport']").remove();
  $("iframe").remove();
  $("header nav").remove();
  $("footer").remove();

  // Remove common Shopify boilerplate selectors
  $("[data-shopify]").remove();
  $(".shopify-section-header").remove();
  $(".shopify-section-footer").remove();

  // Remove empty attributes and excessive whitespace
  let text = $.html();
  // Collapse runs of whitespace
  text = text.replace(/\s{2,}/g, " ");
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  if (text.length > MAX_HTML_CHARS) {
    text = text.slice(0, MAX_HTML_CHARS);
  }
  return text;
}

// ─── SSE stream reader ──────────────────────────────────────────────────────

export async function readSSEStream(
  response: Response,
  requestId: string
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response body is not readable");
  }

  const decoder = new TextDecoder();
  let accumulated = "";
  let chunkCount = 0;
  let firstRawChunk: string | null = null;

  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (event.data === "[DONE]") return;

      try {
        const chunk = JSON.parse(event.data);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          accumulated += delta;
        }
        if (chunk.error) {
          log("error", "SSE stream contained error", {
            requestId,
            error: JSON.stringify(chunk.error).slice(0, 500),
          });
        }
      } catch {
        log("debug", "Skipped malformed SSE chunk", {
          requestId,
          chunk: event.data.slice(0, 200),
        });
      }
    },
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const rawText = decoder.decode(value, { stream: true });
      chunkCount++;

      if (chunkCount === 1) {
        firstRawChunk = rawText.slice(0, 500);
      }

      parser.feed(rawText);
    }
  } finally {
    reader.releaseLock();
  }

  if (accumulated.length === 0) {
    log("warn", "SSE stream produced no content", {
      requestId,
      totalChunks: chunkCount,
      firstRawChunk,
    });
  }

  return accumulated;
}

// ─── Main generator function ────────────────────────────────────────────────

export async function generateSchemas(
  html: string,
  url: string
): Promise<GeneratorResult> {
  if (!INFERENCE_URL || !INFERENCE_KEY || !INFERENCE_MODEL) {
    throw new Error(
      "Missing Heroku Inference environment variables (HEROKU_INFERENCE_URL, HEROKU_INFERENCE_KEY, HEROKU_INFERENCE_MODEL)"
    );
  }

  const requestId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();

  const cleanedHtml = preprocessHtml(html);

  log("info", "Starting schema generation", {
    requestId,
    url,
    rawHtmlLength: html.length,
    cleanedHtmlLength: cleanedHtml.length,
    model: INFERENCE_MODEL,
  });

  const messages: LLMMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `URL: ${url}\n\nHTML CONTENT:\n${cleanedHtml}`,
    },
  ];

  const systemPromptTokenEstimate = Math.ceil(SYSTEM_PROMPT.length / 4);
  const userContentTokenEstimate = Math.ceil(messages[1].content.length / 4);

  log("debug", "Request payload prepared", {
    requestId,
    endpoint: INFERENCE_URL.replace(/\/+$/, "") + "/v1/chat/completions",
    systemPromptChars: SYSTEM_PROMPT.length,
    userContentChars: messages[1].content.length,
    estimatedInputTokens: systemPromptTokenEstimate + userContentTokenEstimate,
    temperature: 0.2,
    maxTokens: 8192,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const endpoint = INFERENCE_URL.replace(/\/+$/, "") + "/v1/chat/completions";
    const fetchStart = Date.now();

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INFERENCE_KEY}`,
      },
      body: JSON.stringify({
        model: INFERENCE_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 8192,
        stream: true,
      }),
      signal: controller.signal,
    });

    const fetchDurationMs = Date.now() - fetchStart;

    log("info", "LLM streaming response started", {
      requestId,
      status: response.status,
      statusText: response.statusText,
      fetchDurationMs,
      contentType: response.headers.get("content-type"),
    });

    if (!response.ok) {
      clearTimeout(timer);
      const errorText = await response.text().catch(() => "Unknown error");
      log("error", "LLM API error response", {
        requestId,
        status: response.status,
        errorBody: errorText.slice(0, 1000),
      });
      throw new Error(
        `LLM API returned ${response.status}: ${errorText}`
      );
    }

    // Accumulate streamed SSE chunks into full content
    const content = await readSSEStream(response, requestId);
    clearTimeout(timer);

    log("info", "LLM streaming complete", {
      requestId,
      contentLength: content.length,
      totalStreamDurationMs: Date.now() - fetchStart,
      contentPreview: content.slice(0, 200),
    });

    if (!content) {
      log("error", "LLM returned empty content", { requestId });
      throw new Error("LLM returned an empty response");
    }

    // Strip markdown code fences if the LLM wrapped the response
    let jsonContent = content.trim();
    if (jsonContent.startsWith("```")) {
      jsonContent = jsonContent
        .replace(/^```(?:json)?\s*\n?/, "")
        .replace(/\n?```\s*$/, "");
      log("warn", "Stripped markdown code fences from LLM response", {
        requestId,
      });
    }

    // Parse and validate the JSON response
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonContent);
    } catch (parseErr) {
      log("error", "LLM response is not valid JSON", {
        requestId,
        parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
        contentPreview: jsonContent.slice(0, 500),
        contentTail: jsonContent.slice(-200),
        contentLength: jsonContent.length,
      });
      throw new Error("LLM response is not valid JSON");
    }

    const validated = generatorResultSchema.safeParse(parsed);
    if (!validated.success) {
      log("error", "LLM response failed schema validation", {
        requestId,
        zodErrors: validated.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
          code: i.code,
        })),
      });
      throw new Error(
        `LLM response does not match expected schema: ${validated.error.issues[0]?.message ?? "Unknown validation error"}`
      );
    }

    const totalDurationMs = Date.now() - startTime;
    log("info", "Schema generation complete", {
      requestId,
      totalDurationMs,
      pageType: validated.data.pageType,
      recommendationCount: validated.data.recommendations.length,
      noteCount: validated.data.notes.length,
    });

    return validated.data;
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      log("error", "LLM request timed out", {
        requestId,
        timeoutMs: TIMEOUT_MS,
        elapsedMs: Date.now() - startTime,
      });
      throw new Error(`LLM request timed out after ${TIMEOUT_MS / 1000} seconds`);
    }
    throw err;
  }
}
