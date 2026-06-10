import * as cheerio from "cheerio";
import type { ExtractedJsonLd } from "./types";

export function extractJsonLd(html: string): ExtractedJsonLd[] {
  const $ = cheerio.load(html);
  const results: ExtractedJsonLd[] = [];
  let globalPosition = 0;

  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).html() ?? "";

    let parsed: unknown = null;
    let parseError: string | undefined;

    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      parseError = err instanceof Error ? err.message : "Invalid JSON";
    }

    if (parseError || parsed === null) {
      results.push({ raw, parsed: null, parseError, position: globalPosition++ });
      return;
    }

    const hasGraph = (v: unknown): boolean =>
      typeof v === "object" &&
      v !== null &&
      "@graph" in v &&
      Array.isArray((v as Record<string, unknown>)["@graph"]);
    const graphOf = (v: unknown): unknown[] =>
      (v as Record<string, unknown>)["@graph"] as unknown[];

    if (Array.isArray(parsed)) {
      // A single <script> can hold a top-level array of schemas. Shopify themes and
      // SchemaGen's own snippet emit `[Organization, Product]` this way. Flatten so each
      // schema is validated on its own — otherwise the whole array is treated as one
      // typeless schema and its members (the Product!) are invisible to validation. This
      // is exactly what made L4 reject SchemaGen's own output.
      for (const item of parsed) {
        if (hasGraph(item)) {
          for (const g of graphOf(item)) {
            results.push({ raw: JSON.stringify(g, null, 2), parsed: g, position: globalPosition++ });
          }
        } else {
          results.push({ raw: JSON.stringify(item, null, 2), parsed: item, position: globalPosition++ });
        }
      }
    } else if (hasGraph(parsed)) {
      // Expand @graph arrays — many sites (WordPress/Yoast, Shopify) wrap all
      // schemas in a single script with "@graph": [...]
      for (const item of graphOf(parsed)) {
        results.push({ raw: JSON.stringify(item, null, 2), parsed: item, position: globalPosition++ });
      }
    } else {
      results.push({ raw, parsed, position: globalPosition++ });
    }
  });

  return results;
}
