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

    // Expand @graph arrays — many sites (WordPress/Yoast, Shopify) wrap all
    // schemas in a single script with "@graph": [...]
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "@graph" in parsed &&
      Array.isArray((parsed as Record<string, unknown>)["@graph"])
    ) {
      const graph = (parsed as Record<string, unknown>)["@graph"] as unknown[];
      for (const item of graph) {
        results.push({
          raw: JSON.stringify(item, null, 2),
          parsed: item,
          position: globalPosition++,
        });
      }
    } else {
      results.push({ raw, parsed, position: globalPosition++ });
    }
  });

  return results;
}
