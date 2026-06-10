import * as cheerio from "cheerio";
import type { ExtractedJsonLd } from "./types";

// ============================================================
// Robust block parsing (issue #20)
//
// Real-world ld+json blocks are frequently NOT clean JSON: themes wrap them in
// CDATA/HTML comments, template engines HTML-encode quotes, hand-written Liquid
// leaves trailing commas, and Shopify metafield rendering emits string values
// containing UNESCAPED quotes (`"value": "["gid://shopify/metaobject/…"]"` —
// seen live on garnerandtow.com/products/duffel). We attempt a conservative
// cleanup/repair pipeline, and when a block STILL cannot be parsed we return it
// as a structured parse-error result instead of dropping it — a broken block is
// live, invalid schema that Google sees, NOT a missing schema.
// ============================================================

/** Strip CDATA wrappers and HTML comment markers around a block. */
function stripWrappers(text: string): string {
  let t = text.trim();
  // Both `<![CDATA[ … ]]>` and the JS-safe `/*<![CDATA[*/ … /*]]>*/` form
  t = t
    .replace(/^\s*(?:\/\*)?\s*<!\[CDATA\[\s*(?:\*\/)?/i, "")
    .replace(/(?:\/\*)?\s*\]\]>\s*(?:\*\/)?\s*$/i, "");
  t = t.replace(/^\s*<!--/, "").replace(/-->\s*$/, "");
  return t.trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: "&",
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

/** Decode HTML entities (&quot; &amp; &#39; &#x27; …) — for blocks a template engine HTML-encoded. */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/**
 * Remove trailing commas before `}` / `]`. String-aware (a literal ", }" inside
 * a string value is left alone), so this cannot corrupt content.
 */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue; // drop the trailing comma
    }
    out += ch;
  }
  return out;
}

/**
 * Conservative repair for unescaped quotes inside JSON string values — the
 * Shopify metaobject pattern: `"value": "["gid://shopify/metaobject/123"]"`.
 *
 * Scans the text with a structural context stack (object-key / object-value /
 * array). A `"` encountered inside a string only CLOSES the string when what
 * follows is structurally plausible for that context (e.g. `:` after a key,
 * `,`+next-key or `}` after an object value); otherwise the quote is escaped.
 * Returns null when nothing needed escaping. Callers must only accept the
 * result if it re-parses cleanly AND looks like JSON-LD (see isPlausibleJsonLd).
 */
function repairUnescapedStringQuotes(text: string): string | null {
  type StringCtx = "objectKey" | "objectValue" | "array" | "top";
  const out: string[] = [];
  const stack: ("object" | "array")[] = [];
  let expectingKey = false;
  let inString = false;
  let stringCtx: StringCtx = "top";
  let changed = false;

  const currentCtx = (): StringCtx => {
    const top = stack[stack.length - 1];
    if (top === "array") return "array";
    if (top === "object") return expectingKey ? "objectKey" : "objectValue";
    return "top";
  };

  const nextNonWsIndex = (i: number): number => {
    for (let j = i + 1; j < text.length; j++) {
      if (!/\s/.test(text[j])) return j;
    }
    return -1;
  };

  /** After closing an object value on `,`, the next thing must be `"key":` — otherwise the `,` was string content. */
  const commaStartsNewKey = (commaIdx: number): boolean => {
    const q = nextNonWsIndex(commaIdx);
    if (q === -1 || text[q] !== '"') return false;
    // Scan the would-be key string to its closing quote (respecting escapes)
    let j = q + 1;
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === '"') break;
      j++;
    }
    if (j >= text.length) return false;
    const colon = nextNonWsIndex(j);
    return colon !== -1 && text[colon] === ":";
  };

  const isValidCloser = (quoteIdx: number, ctx: StringCtx): boolean => {
    const n = nextNonWsIndex(quoteIdx);
    const next = n === -1 ? "" : text[n];
    switch (ctx) {
      case "objectKey":
        return next === ":";
      case "objectValue":
        if (next === "}") return true;
        if (next === ",") return commaStartsNewKey(n);
        return false;
      case "array":
        return next === "," || next === "]";
      case "top":
        return next === "";
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        out.push(ch, text[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === '"') {
        if (isValidCloser(i, stringCtx)) {
          inString = false;
          out.push(ch);
        } else {
          out.push('\\"');
          changed = true;
        }
        continue;
      }
      out.push(ch);
      continue;
    }

    switch (ch) {
      case '"':
        inString = true;
        stringCtx = currentCtx();
        out.push(ch);
        break;
      case "{":
        stack.push("object");
        expectingKey = true;
        out.push(ch);
        break;
      case "[":
        stack.push("array");
        out.push(ch);
        break;
      case "}":
      case "]":
        stack.pop();
        expectingKey = false;
        out.push(ch);
        break;
      case ":":
        if (stack[stack.length - 1] === "object") expectingKey = false;
        out.push(ch);
        break;
      case ",":
        if (stack[stack.length - 1] === "object") expectingKey = true;
        out.push(ch);
        break;
      default:
        out.push(ch);
    }
  }

  return changed ? out.join("") : null;
}

/** A repaired parse is only accepted when the result actually looks like JSON-LD. */
function isPlausibleJsonLd(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => isPlausibleJsonLd(v));
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return "@type" in obj || "@graph" in obj || "@context" in obj;
}

/**
 * Parse one ld+json block through the cleanup/repair pipeline:
 *   1. plain JSON.parse (after stripping CDATA / comment wrappers)
 *   2. HTML-entity decode, then trailing-comma cleanup, retried in combination
 *   3. unescaped-quote repair (Shopify metaobject pattern) — only accepted when
 *      the repaired text re-parses AND the result contains @type/@graph/@context
 */
function parseJsonLdBlock(raw: string): { parsed: unknown; parseError?: string } {
  const base = stripWrappers(raw);

  let firstError: string;
  try {
    return { parsed: JSON.parse(base) };
  } catch (err) {
    firstError = err instanceof Error ? err.message : "Invalid JSON";
  }

  // Mild cleanups, cheapest first. Each candidate is only kept if it differs.
  const candidates: string[] = [];
  const decoded = decodeHtmlEntities(base);
  if (decoded !== base) candidates.push(decoded);
  for (const c of [base, decoded]) {
    const stripped = stripTrailingCommas(c);
    if (stripped !== c && !candidates.includes(stripped)) candidates.push(stripped);
  }

  for (const candidate of candidates) {
    try {
      return { parsed: JSON.parse(candidate) };
    } catch {
      // try the next cleanup
    }
  }

  // Last resort: the conservative quote repair, gated on plausibility.
  for (const candidate of [base, ...candidates]) {
    const repaired = repairUnescapedStringQuotes(candidate);
    if (!repaired) continue;
    try {
      const parsed = JSON.parse(repaired);
      if (isPlausibleJsonLd(parsed)) return { parsed };
    } catch {
      // repair did not produce clean JSON — reject it
    }
  }

  return { parsed: null, parseError: firstError };
}

// ============================================================
// @context propagation (issue #19)
// ============================================================

/**
 * When a `@graph` wrapper (or wrapper inside a top-level array) is flattened,
 * its members inherit the wrapper's `@context` per JSON-LD semantics. Without
 * this, valid members (garnerandtow's BreadcrumbList/HowTo/Product inside one
 * `@graph`) are falsely flagged MISSING_CONTEXT.
 */
function withParentContext(member: unknown, parentContext: unknown): unknown {
  if (
    parentContext === undefined ||
    member === null ||
    typeof member !== "object" ||
    Array.isArray(member)
  ) {
    return member;
  }
  const obj = member as Record<string, unknown>;
  if ("@context" in obj) return member;
  return { "@context": parentContext, ...obj };
}

export function extractJsonLd(html: string): ExtractedJsonLd[] {
  const $ = cheerio.load(html);
  const results: ExtractedJsonLd[] = [];
  let globalPosition = 0;

  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).html() ?? "";
    if (!raw.trim()) return; // empty block — nothing to validate or report

    const { parsed, parseError } = parseJsonLdBlock(raw);

    if (parseError || parsed === null) {
      // NEVER drop an unparseable block silently. It is live, broken structured
      // data on the page — downstream must treat it as invalid schema present,
      // not as "schema missing" (which would generate a duplicate).
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
    const contextOf = (v: unknown): unknown =>
      typeof v === "object" && v !== null
        ? (v as Record<string, unknown>)["@context"]
        : undefined;

    const pushExpanded = (member: unknown, parentContext: unknown) => {
      const m = withParentContext(member, parentContext);
      results.push({
        raw: JSON.stringify(m, null, 2),
        parsed: m,
        position: globalPosition++,
      });
    };

    if (Array.isArray(parsed)) {
      // A single <script> can hold a top-level array of schemas. Shopify themes and
      // SchemaGen's own snippet emit `[Organization, Product]` this way. Flatten so each
      // schema is validated on its own — otherwise the whole array is treated as one
      // typeless schema and its members (the Product!) are invisible to validation. This
      // is exactly what made L4 reject SchemaGen's own output.
      for (const item of parsed) {
        if (hasGraph(item)) {
          for (const g of graphOf(item)) {
            pushExpanded(g, contextOf(item));
          }
        } else {
          pushExpanded(item, undefined);
        }
      }
    } else if (hasGraph(parsed)) {
      // Expand @graph arrays — many sites (WordPress/Yoast, Shopify) wrap all
      // schemas in a single script with "@graph": [...]. Members inherit the
      // wrapper's @context.
      for (const item of graphOf(parsed)) {
        pushExpanded(item, contextOf(parsed));
      }
    } else {
      results.push({ raw, parsed, position: globalPosition++ });
    }
  });

  return results;
}
