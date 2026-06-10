/**
 * Reversible JSON-LD suppression primitives (issue #23). Pure text transforms —
 * no I/O; the orchestrator fetches/writes the asset around these.
 *
 * To make SchemaGen authoritative we must silence a theme's own JSON-LD
 * emission WITHOUT destroying merchant code. The matched region — the whole
 * `<script type="application/ld+json">…</script>` element including any Liquid
 * inside it — is wrapped in a reversible marker sandwich:
 *
 *   {% comment %}SCHEMAGEN:SUPPRESS:START{% endcomment %}{% if false %}
 *   ...original element, byte-identical...
 *   {% endif %}{% comment %}SCHEMAGEN:SUPPRESS:END{% endcomment %}
 *
 * `{% if false %}` is the suppression mechanism: Liquid still PARSES the body
 * (so the wrapped tags must nest cleanly) but never renders it. That gives the
 * safety rules below:
 *
 *  SAFE      arbitrary output tags ({{ … }}), filters, and BALANCED block tags
 *            (if/endif, for/endfor, …) inside the region — they parse fine
 *            under an enclosing {% if false %}.
 *  NOT SAFE  {% raw %} / {% comment %} (and section tags {% schema %},
 *            {% javascript %}, {% stylesheet %}) inside the region: their
 *            bodies are not parsed as Liquid, so static analysis of the region
 *            cannot be trusted and our wrapper could land inside one of them,
 *            breaking nesting. Detected → { ok: false, reason } and the
 *            orchestrator surfaces a merchant action instead. Conservative
 *            over clever.
 *  NOT SAFE  unbalanced block tags in the region (e.g. an {% endif %} whose
 *            {% if %} is outside the script element) — wrapping would produce
 *            invalid Liquid. Detected → { ok: false, reason }.
 *
 * unsuppressAll() strips every wrapper restoring the original bytes exactly
 * (round-trip property: unsuppressAll(suppress(x)) === x), and suppressing an
 * already-suppressed region is a no-op (idempotent).
 */

export const SUPPRESS_PREFIX =
  "{% comment %}SCHEMAGEN:SUPPRESS:START{% endcomment %}{% if false %}";
export const SUPPRESS_SUFFIX =
  "{% endif %}{% comment %}SCHEMAGEN:SUPPRESS:END{% endcomment %}";

/** Marker substring used to detect pre-existing/stray suppression text. */
const MARKER_SUBSTRING = "SCHEMAGEN:SUPPRESS";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Script-element ranges
// ---------------------------------------------------------------------------

export interface JsonLdScriptRange {
  /** Index of `<` of the opening tag. */
  start: number;
  /** Index just past `>` of the closing tag (exclusive). */
  end: number;
  /** The whole element text, assetText.slice(start, end). */
  text: string;
}

const SCRIPT_OPEN_RE =
  /<script\b[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json')[^>]*>/gi;
const SCRIPT_CLOSE_RE = /<\/script\s*>/gi;

/**
 * Find every `<script type="application/ld+json">…</script>` element in raw
 * asset text. Ranges cover the WHOLE element (tags included) — that is the
 * emitting region suppression must wrap.
 *
 * Assumption (documented, load-bearing): the first `</script>` after an opener
 * is a safe terminator. HTML itself guarantees script content cannot contain a
 * literal `</script` without ending the element, so any well-formed theme
 * asset satisfies this at the source-text level. Liquid that would RENDER a
 * closing tag at runtime is invisible to static analysis and out of scope.
 * An opener with no closer (malformed asset) yields no range.
 */
export function findJsonLdScriptRanges(assetText: string): JsonLdScriptRange[] {
  const ranges: JsonLdScriptRange[] = [];
  SCRIPT_OPEN_RE.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = SCRIPT_OPEN_RE.exec(assetText)) !== null) {
    SCRIPT_CLOSE_RE.lastIndex = open.index + open[0].length;
    const close = SCRIPT_CLOSE_RE.exec(assetText);
    if (!close) break; // unterminated element — nothing safe to wrap
    const start = open.index;
    const end = close.index + close[0].length;
    ranges.push({ start, end, text: assetText.slice(start, end) });
    SCRIPT_OPEN_RE.lastIndex = end;
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Liquid safety analysis
// ---------------------------------------------------------------------------

/**
 * Tags whose body is NOT parsed as Liquid (or that may not nest inside
 * {% if %}). Their presence anywhere in the region makes static analysis
 * untrustworthy → not suppressible.
 */
const REFUSED_TAGS = new Set([
  "raw",
  "endraw",
  "comment",
  "endcomment",
  "schema",
  "endschema",
  "javascript",
  "endjavascript",
  "stylesheet",
  "endstylesheet",
]);

/** Block tags that must be balanced inside the region for the wrapper to nest. */
const BLOCK_TAG_PAIRS: Record<string, string> = {
  if: "endif",
  unless: "endunless",
  case: "endcase",
  for: "endfor",
  capture: "endcapture",
  form: "endform",
  paginate: "endpaginate",
  tablerow: "endtablerow",
};
const BLOCK_CLOSERS = new Map(
  Object.entries(BLOCK_TAG_PAIRS).map(([open, close]) => [close, open])
);

const LIQUID_TAG_RE = /\{\%-?\s*(\w+)/g;

/**
 * Returns null when the region is safe to wrap in {% if false %}, else a
 * human-readable reason it is not suppressible.
 */
export function findUnsuppressibleReason(region: string): string | null {
  if (region.includes(MARKER_SUBSTRING)) {
    return "region already contains SCHEMAGEN:SUPPRESS marker text";
  }
  const stack: string[] = [];
  LIQUID_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LIQUID_TAG_RE.exec(region)) !== null) {
    const tag = m[1];
    if (REFUSED_TAGS.has(tag)) {
      return `region contains {% ${tag} %} — its body is not parsed as Liquid, so wrapping cannot be verified safe`;
    }
    if (tag in BLOCK_TAG_PAIRS) {
      stack.push(tag);
    } else if (BLOCK_CLOSERS.has(tag)) {
      const expected = BLOCK_CLOSERS.get(tag);
      if (stack.pop() !== expected) {
        return `region contains unbalanced {% ${tag} %} — wrapping in {% if false %} would break Liquid nesting`;
      }
    }
  }
  if (stack.length > 0) {
    return `region contains unclosed {% ${stack[stack.length - 1]} %} — wrapping in {% if false %} would break Liquid nesting`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// suppress / unsuppress / list
// ---------------------------------------------------------------------------

export interface SuppressMatch {
  /** Suppress every JSON-LD script element whose text contains this substring. */
  contains?: string;
  /** Or suppress exactly the Nth range from findJsonLdScriptRanges. */
  index?: number;
}

export type SuppressResult =
  | {
      ok: true;
      text: string;
      /** false when every matched region was already suppressed (no-op). */
      changed: boolean;
      /** Number of regions newly wrapped by this call. */
      suppressed: number;
    }
  | { ok: false; reason: string };

/** Is this range already wrapped by our suppression markers? */
function isAlreadySuppressed(assetText: string, r: JsonLdScriptRange): boolean {
  return (
    r.start >= SUPPRESS_PREFIX.length &&
    assetText.startsWith(SUPPRESS_PREFIX, r.start - SUPPRESS_PREFIX.length) &&
    assetText.startsWith(SUPPRESS_SUFFIX, r.end)
  );
}

/**
 * Wrap the matched JSON-LD-emitting script element(s) in reversible
 * suppression markers. `match.contains` selects by substring (all matching
 * elements), `match.index` selects one range by position; an empty match
 * selects every JSON-LD element in the asset.
 *
 * Idempotent: regions already wrapped are skipped; if nothing new needs
 * wrapping the original text is returned with changed:false. All-or-nothing:
 * if ANY matched region fails the Liquid-safety check, no text is modified.
 */
export function suppressJsonLdEmission(
  assetText: string,
  opts: { match: SuppressMatch }
): SuppressResult {
  const { match } = opts;
  const ranges = findJsonLdScriptRanges(assetText);

  let selected: JsonLdScriptRange[];
  if (match.index !== undefined) {
    const r = ranges[match.index];
    if (!r) {
      return {
        ok: false,
        reason: `no JSON-LD script element at index ${match.index} (found ${ranges.length})`,
      };
    }
    selected = [r];
  } else if (match.contains !== undefined) {
    const needle = match.contains;
    selected = ranges.filter((r) => r.text.includes(needle));
    if (selected.length === 0) {
      return {
        ok: false,
        reason: `no JSON-LD script element contains ${JSON.stringify(needle)}`,
      };
    }
  } else {
    selected = ranges;
    if (selected.length === 0) {
      return { ok: false, reason: "asset contains no JSON-LD script element" };
    }
  }

  const toWrap = selected.filter((r) => !isAlreadySuppressed(assetText, r));
  // Safety-check every region BEFORE touching anything (all-or-nothing).
  for (const r of toWrap) {
    const reason = findUnsuppressibleReason(r.text);
    if (reason) return { ok: false, reason: `${reason} (at offset ${r.start})` };
  }
  if (toWrap.length === 0) {
    return { ok: true, text: assetText, changed: false, suppressed: 0 };
  }

  // Wrap right-to-left so earlier offsets stay valid.
  let text = assetText;
  for (const r of [...toWrap].sort((a, b) => b.start - a.start)) {
    text =
      text.slice(0, r.start) +
      SUPPRESS_PREFIX +
      text.slice(r.start, r.end) +
      SUPPRESS_SUFFIX +
      text.slice(r.end);
  }
  return { ok: true, text, changed: true, suppressed: toWrap.length };
}

const WRAPPER_RE = new RegExp(
  `${escapeRegExp(SUPPRESS_PREFIX)}([\\s\\S]*?)${escapeRegExp(SUPPRESS_SUFFIX)}`,
  "g"
);

/**
 * Remove every SCHEMAGEN:SUPPRESS wrapper, restoring the original bytes
 * exactly: unsuppressAll(suppress(x)) === x. A replacement FUNCTION is used so
 * `$`-sequences in merchant content cannot be misinterpreted as replace patterns.
 */
export function unsuppressAll(assetText: string): string {
  return assetText.replace(WRAPPER_RE, (_whole, inner: string) => inner);
}

export interface SuppressionListing {
  /** Wrapper bounds (marker text included), for audit/report. */
  start: number;
  end: number;
  /** Bounds of the original suppressed content inside the wrapper. */
  inner: { start: number; end: number };
  /** Whitespace-collapsed preview of the suppressed content. */
  preview: string;
}

const PREVIEW_LENGTH = 120;

/** List every suppressed region in an asset, with previews for audit/report. */
export function listSuppressions(assetText: string): SuppressionListing[] {
  const listings: SuppressionListing[] = [];
  WRAPPER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WRAPPER_RE.exec(assetText)) !== null) {
    const inner = m[1];
    const innerStart = m.index + SUPPRESS_PREFIX.length;
    const collapsed = inner.replace(/\s+/g, " ").trim();
    listings.push({
      start: m.index,
      end: m.index + m[0].length,
      inner: { start: innerStart, end: innerStart + inner.length },
      preview:
        collapsed.length > PREVIEW_LENGTH
          ? `${collapsed.slice(0, PREVIEW_LENGTH)}…`
          : collapsed,
    });
  }
  return listings;
}
