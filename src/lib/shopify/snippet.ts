/**
 * Snippet renderer (agent Phase 1): map per-page schema entries into the managed
 * Liquid snippet `snippets/schemagen-jsonld.liquid`.
 *
 * Each entry emits a guarded block. The GUARD is Liquid (template/handle
 * conditionals) so the right page gets the right schema; the JSON-LD itself is
 * the static, already-validated object captured for that page:
 *
 *   {%- if template contains 'product' and product.handle == 'blue-widget' -%}
 *   <script type="application/ld+json">
 *   { ...validated JSON-LD... }
 *   </script>
 *   {%- endif -%}
 *
 * The JSON-LD payload can carry attacker-influenced strings (scraped / LLM-
 * generated page content), so renderScript neutralizes it by escaping breakout
 * characters as JSON unicode escapes -- NOT by wrapping in {% raw %}, which a
 * value containing the literal `{% endraw %}` could break out of (server-side
 * Liquid injection). The guard (template/handle) is built only from validated
 * slugs. See renderScript / conditionFor.
 */

export interface SnippetEntry {
  /** Shopify template name: product, collection, page, article, blog, index, ... */
  template: string;
  /** Resource handle for handle-specific targeting (optional). */
  handle?: string;
  /** Validated JSON-LD object (or array of objects). */
  jsonld: unknown;
}

/** template name -> the Liquid object whose `.handle` identifies the resource. */
const HANDLE_OBJECT: Record<string, string> = {
  product: "product",
  collection: "collection",
  page: "page",
  article: "article",
  blog: "blog",
};

const HEADER =
  "{%- comment -%}\n" +
  "  SchemaGen managed snippet - generated automatically. Do not edit by hand.\n" +
  "{%- endcomment -%}\n";

// Shopify handles are lowercase alphanumeric + hyphen/underscore; templates add
// dots (e.g. "product.custom"). Validating against these (rather than relying on
// Liquid's under-specified string-escape rules) is what actually prevents a
// crafted handle/template from injecting Liquid into the conditional.
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]*$/;
const TEMPLATE_RE = /^[a-z0-9][a-z0-9_.-]*$/;

/** Single-quoted Liquid string literal (belt-and-suspenders; inputs are validated). */
function liquidStr(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function conditionFor(entry: SnippetEntry): string {
  if (!TEMPLATE_RE.test(entry.template)) {
    throw new Error(`Invalid Shopify template: ${JSON.stringify(entry.template)}`);
  }
  // `contains` not `==` so "product.custom" templates still match "product".
  const parts = [`template contains ${liquidStr(entry.template)}`];
  if (entry.handle) {
    if (!HANDLE_RE.test(entry.handle)) {
      throw new Error(`Invalid Shopify handle: ${JSON.stringify(entry.handle)}`);
    }
    const obj = HANDLE_OBJECT[entry.template];
    if (obj) parts.push(`${obj}.handle == ${liquidStr(entry.handle)}`);
  }
  return parts.join(" and ");
}

function renderScript(jsonld: unknown): string {
  // Escape breakout vectors as JSON unicode escapes (valid JSON that the
  // browser's JSON-LD parser restores to the original characters):
  //  - `<`         -> escaped: a value can't close </script> or inject a tag
  //  - `{{` / `{%` -> escape the opening brace: Liquid never sees an opener, so
  //                   the payload is inert (`{% endraw %}` / `{{ shop.x }}` is dead text)
  // Pretty-printing guarantees `{{`/`{%` never appear in the JSON structure
  // itself (only inside string values), so neutralizing the opener `{` is safe.
  // No {% raw %} wrapper => nothing for raw to be broken out of. (U+2028/9 are
  // left as-is: inside application/ld+json they are valid JSON, not a JS break.)
  const json = JSON.stringify(jsonld, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\{(?=[{%])/g, "\\u007b");
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

/**
 * Render the full snippet from the given entries. Deterministic: same entries in
 * the same order always produce byte-identical output (so re-renders are no-ops).
 * Empty entries yield just the managed-by header.
 */
export function renderSchemaGenSnippet(entries: SnippetEntry[]): string {
  if (entries.length === 0) return HEADER;
  const blocks = entries.map(
    (e) => `{%- if ${conditionFor(e)} -%}\n${renderScript(e.jsonld)}\n{%- endif -%}`
  );
  return HEADER + blocks.join("\n") + "\n";
}

export interface TemplateTarget {
  template: string;
  handle?: string;
}

/**
 * Map a storefront URL to its Shopify template + handle, for keying snippet
 * entries off the URLs SchemaGen already stores in page_schemas.
 * Returns null for paths that don't map to a known template.
 */
export function urlToTemplateTarget(url: string): TemplateTarget | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  const seg = path.replace(/^\/+|\/+$/g, "").split("/");
  if (seg.length === 0 || seg[0] === "") return { template: "index" };

  switch (seg[0]) {
    case "products":
      return seg[1]
        ? { template: "product", handle: seg[1] }
        : { template: "product" };
    case "collections":
      // /collections/<c>/products/<h> targets the product page
      if (seg[2] === "products" && seg[3]) {
        return { template: "product", handle: seg[3] };
      }
      return seg[1]
        ? { template: "collection", handle: seg[1] }
        : { template: "collection" };
    case "pages":
      return seg[1] ? { template: "page", handle: seg[1] } : { template: "page" };
    case "blogs":
      // /blogs/<blog>/<article>
      if (seg[2]) return { template: "article", handle: seg[2] };
      return seg[1] ? { template: "blog", handle: seg[1] } : { template: "blog" };
    default:
      return null;
  }
}
