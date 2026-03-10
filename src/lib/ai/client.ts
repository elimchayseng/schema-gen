import * as cheerio from "cheerio";
import { z } from "zod";
import type { GeneratorResult, LLMMessage, LLMResponse } from "./types";

// ─── Environment ────────────────────────────────────────────────────────────

const INFERENCE_URL = process.env.HEROKU_INFERENCE_URL;
const INFERENCE_KEY = process.env.HEROKU_INFERENCE_KEY;
const INFERENCE_MODEL = process.env.HEROKU_INFERENCE_MODEL;

const MAX_HTML_CHARS = 80_000;
const TIMEOUT_MS = 30_000;

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

function preprocessHtml(html: string): string {
  const $ = cheerio.load(html);
  $("script").remove();
  $("style").remove();
  $("svg").remove();
  $("noscript").remove();

  let text = $.html();
  if (text.length > MAX_HTML_CHARS) {
    text = text.slice(0, MAX_HTML_CHARS);
  }
  return text;
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

  const cleanedHtml = preprocessHtml(html);

  const messages: LLMMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `URL: ${url}\n\nHTML CONTENT:\n${cleanedHtml}`,
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(INFERENCE_URL, {
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
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `LLM API returned ${response.status}: ${errorText}`
      );
    }

    const llmResponse = (await response.json()) as LLMResponse;
    const content = llmResponse.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("LLM returned an empty response");
    }

    // Parse and validate the JSON response
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("LLM response is not valid JSON");
    }

    const validated = generatorResultSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(
        `LLM response does not match expected schema: ${validated.error.issues[0]?.message ?? "Unknown validation error"}`
      );
    }

    return validated.data;
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("LLM request timed out after 30 seconds");
    }
    throw err;
  }
}
