/**
 * Schema source locator (issue #22).
 *
 * To become the AUTHORITATIVE source of structured data on a store, SchemaGen
 * must first know where every existing JSON-LD block on a rendered page comes
 * from:
 *
 *   schemagen          — our own managed snippet (we re-render it; never suppress it)
 *   theme:<asset_key>  — emitted by an editable theme asset (we can suppress it
 *                        via suppress.ts and a theme write)
 *   external           — no theme asset plausibly emits it: injected by an app /
 *                        ScriptTag. Not removable via theme edits → merchant action.
 *   unknown            — ambiguous evidence; surfaced for human review, never acted on.
 *
 * Matching strategy: a rendered block is the OUTPUT of a Liquid template, so we
 * can't diff it against asset text directly. What survives templating are the
 * static literal runs — JSON keys and hard-coded string values like
 * `"@type": "Product"` or `"https://schema.org/InStock"`. We tokenize the
 * rendered block into its quoted string literals, weight distinctive tokens
 * over universal JSON-LD scaffolding (`"@context"`, `"name"`, …), and prefer
 * the asset whose static literals overlap the block most. A verbatim
 * (whitespace-normalized) containment is an "exact" match; a clear token-overlap
 * winner is "likely"; ties and weak overlap are "unknown"; zero distinctive
 * overlap anywhere is "external".
 *
 * This works on UNPARSEABLE blocks too (parseError set, parsed null) — the
 * garnerandtow broken Product block — because tokenization runs on the raw text.
 *
 * All Shopify I/O is injected (SourceLocatorOps), mirroring apply.ts's
 * ThemeAssetOps idiom, so unit tests drive an in-memory theme and never touch
 * the network. makeSourceLocatorOps() wires the real Asset API for production.
 */
import { assetGet, assetsList } from "./assets";
import { SNIPPET_NAME } from "./theme-liquid";
import type { ShopContext, ShopifyAsset } from "./types";

/**
 * Same value as install.ts#SNIPPET_ASSET_KEY, derived here from SNIPPET_NAME so
 * this module doesn't pull install.ts's backup/db transitive deps into the
 * pure-classification path.
 */
export const SCHEMAGEN_SNIPPET_KEY = `snippets/${SNIPPET_NAME}.liquid`;

/** One JSON-LD block extracted from a rendered page (extractor.ts output shape). */
export interface RenderedJsonLdBlock {
  raw: string;
  parsed: unknown;
  parseError?: string;
  position: number;
}

/** The minimal asset surface the locator needs (injectable for tests). */
export interface SourceLocatorOps {
  assetsList(themeId: number): Promise<ShopifyAsset[]>;
  assetGet(themeId: number, key: string): Promise<ShopifyAsset>;
}

export type SchemaSourceConfidence = "exact" | "likely" | "none";

export interface SchemaSourceResult {
  position: number;
  /** "schemagen" | "theme:<asset_key>" | "external" | "unknown" */
  source: string;
  /** Set for schemagen and theme:* sources. */
  assetKey?: string;
  confidence: SchemaSourceConfidence;
  /** Human-readable evidence for the classification (audit / report). */
  matchedBy: string;
  /**
   * The `contains` needle a suppression should use to find the emitting script
   * element INSIDE the asset. Set for filter-based emissions (the Liquid
   * expression, e.g. `{{ product | structured_data }}`), where the rendered
   * block's literals never appear in the asset text.
   */
  needle?: string;
  /**
   * Other theme assets that emit the same kind of block via the structured_data
   * filter. Authoritative mode suppresses these too — they are the same
   * competing markup rendered from a different section.
   */
  alsoEmittedBy?: { assetKey: string; needle: string }[];
}

// ---------------------------------------------------------------------------
// Emitter discovery + cache
// ---------------------------------------------------------------------------

/** Theme paths that can plausibly emit markup into a rendered page. */
const EMITTER_KEY_RE = /^(layout|snippets|sections|templates)\/.+\.liquid$/;

/** Does this asset's text look like it emits (or builds) a JSON-LD block? */
function looksLikeSchemaEmitter(text: string): boolean {
  if (/application\/ld\+json/i.test(text)) return true;
  // A snippet can build the JSON without the <script> wrapper (rendered elsewhere).
  return text.includes('"@type"') && /schema\.org/i.test(text);
}

interface EmitterAsset {
  key: string;
  /**
   * Texts a block is matched against. One entry for ordinary theme assets; the
   * schemagen snippet gets a second entry with renderScript's JSON unicode
   * escapes undone — a rendered block can carry either the literal `<`
   * escapes (raw page text) or the restored characters (extractor re-serializes
   * @graph/array members from parsed JSON).
   */
  haystacks: string[];
  /** Whitespace-normalized haystacks, for verbatim containment checks. */
  normHaystacks: string[];
  /**
   * Shopify `| structured_data` filter expressions found in this asset. These
   * emit complete JSON-LD AT RENDER TIME, so none of the rendered literals
   * appear in the asset text — they are matched by OBJECT KIND instead
   * (a `{{ product | structured_data }}` emits Product/ProductGroup, etc.).
   */
  filterExpressions: { expression: string; kind: FilterKind }[];
}

type FilterKind = "product" | "article" | "collection" | "other";

const STRUCTURED_DATA_FILTER_RE = /\{\{[^{}]*\|\s*structured_data[^{}]*\}\}/g;

function filterKindOf(expression: string): FilterKind {
  const e = expression.toLowerCase();
  if (e.includes("product")) return "product";
  if (e.includes("article") || e.includes("blog")) return "article";
  if (e.includes("collection")) return "collection";
  return "other";
}

/** Schema types the structured_data filter emits per Liquid object kind. */
const FILTER_KIND_TYPES: Record<FilterKind, string[]> = {
  product: ["Product", "ProductGroup"],
  article: ["Article", "BlogPosting", "NewsArticle"],
  collection: ["CollectionPage", "ItemList"],
  other: [],
};

/** The block's schema type kind, tolerant of unparseable raw text. */
function blockFilterKind(block: RenderedJsonLdBlock): FilterKind | null {
  const declares = (type: string): boolean =>
    block.parsed != null
      ? JSON.stringify(block.parsed).includes(`"${type}"`)
      : new RegExp(`"@type"\\s*:\\s*"${type}"`).test(block.raw);
  for (const kind of ["product", "article", "collection"] as const) {
    if (FILTER_KIND_TYPES[kind].some(declares)) return kind;
  }
  return null;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * snippet.ts#renderScript escapes `<` and `{` (before `{`/`%`) as JSON unicode
 * escapes in the embedded JSON. Undo those to build the second matching form
 * of the schemagen snippet.
 */
function unescapeSnippetJson(text: string): string {
  return text.replace(/\\u003c/gi, "<").replace(/\\u007b/gi, "{");
}

/**
 * Per-ops, per-theme cache of fetched emitter assets so repeated
 * locateSchemaSources calls (one per scanned page) don't refetch the theme.
 * Keyed by the ops object: a fresh ops (new shop/session/test) gets a fresh cache.
 */
const emitterCache = new WeakMap<SourceLocatorOps, Map<number, EmitterAsset[]>>();

async function loadEmitters(
  ops: SourceLocatorOps,
  themeId: number
): Promise<EmitterAsset[]> {
  let byTheme = emitterCache.get(ops);
  if (!byTheme) {
    byTheme = new Map();
    emitterCache.set(ops, byTheme);
  }
  const cached = byTheme.get(themeId);
  if (cached) return cached;

  const all = await ops.assetsList(themeId);
  const plausible = all.filter((a) => EMITTER_KEY_RE.test(a.key));

  // Fetch the candidate assets with bounded concurrency (issue #35): the prior
  // serial assetGet-per-file was O(assets) round-trips on every authoritative run
  // and bit hard at full-catalog scale. Order is preserved so the emitter list
  // (and therefore needle selection) stays deterministic.
  const FETCH_CONCURRENCY = 4;
  const fetched: (Awaited<ReturnType<SourceLocatorOps["assetGet"]>> | null)[] =
    new Array(plausible.length).fill(null);
  for (let i = 0; i < plausible.length; i += FETCH_CONCURRENCY) {
    const batch = plausible.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map((meta) => ops.assetGet(themeId, meta.key))
    );
    results.forEach((full, j) => {
      fetched[i + j] = full;
    });
  }

  const emitters: EmitterAsset[] = [];
  for (let idx = 0; idx < plausible.length; idx++) {
    const meta = plausible[idx];
    const text = fetched[idx]?.value;
    if (text == null) continue;
    const filterExpressions = (text.match(STRUCTURED_DATA_FILTER_RE) ?? []).map(
      (expression) => ({ expression, kind: filterKindOf(expression) })
    );
    if (!looksLikeSchemaEmitter(text) && filterExpressions.length === 0) continue;
    const haystacks = [text];
    if (meta.key === SCHEMAGEN_SNIPPET_KEY) {
      const unescaped = unescapeSnippetJson(text);
      if (unescaped !== text) haystacks.push(unescaped);
    }
    emitters.push({
      key: meta.key,
      haystacks,
      normHaystacks: haystacks.map(normalizeWs),
      filterExpressions,
    });
  }
  byTheme.set(themeId, emitters);
  return emitters;
}

// ---------------------------------------------------------------------------
// Static-literal token matching
// ---------------------------------------------------------------------------

/**
 * Universal JSON-LD scaffolding present in virtually every schema block and
 * every schema-emitting template. These prove nothing about WHICH asset emitted
 * a block, so they carry minimal weight.
 */
const COMMON_TOKENS = new Set([
  "@context",
  "@type",
  "@id",
  "@graph",
  "name",
  "url",
  "image",
  "description",
  "offers",
  "price",
  "priceCurrency",
  "availability",
  "brand",
  "sku",
  "item",
  "position",
  "itemListElement",
  "https://schema.org",
  "http://schema.org",
  "https://schema.org/",
  "http://schema.org/",
]);

/**
 * Quoted-string-literal tokenizer (issue #37 dedup). The single definition the
 * suppression-needle picker (run.ts pickContainsLiteral) and this locator both
 * use — they MUST agree on what a "literal" is. Only ever used with
 * String.prototype.match (which ignores lastIndex), so sharing the /g instance is
 * safe; do not use it with .exec in a loop without resetting lastIndex.
 */
export const STRING_LITERAL_RE = /"(?:[^"\\\n]|\\.)*"/g;
const MAX_TOKENS = 200;

interface BlockToken {
  /** Token WITH surrounding quotes — matched literally against asset text. */
  literal: string;
  weight: number;
  common: boolean;
}

/** Extract the quoted string literals of a block (works on unparseable raw too). */
function extractTokens(raw: string): BlockToken[] {
  const seen = new Set<string>();
  const tokens: BlockToken[] = [];
  for (const m of raw.match(STRING_LITERAL_RE) ?? []) {
    if (tokens.length >= MAX_TOKENS) break;
    const inner = m.slice(1, -1);
    if (inner.length < 2 || seen.has(m)) continue;
    seen.add(m);
    const common = COMMON_TOKENS.has(inner);
    tokens.push({
      literal: m,
      common,
      // Longer literals are stronger evidence (a full URL or sentence that
      // appears in BOTH the block and an asset is near-conclusive).
      weight: common ? 1 : Math.min(m.length, 40),
    });
  }
  return tokens;
}

interface AssetScore {
  emitter: EmitterAsset;
  score: number;
  matchedDistinctive: number;
  distinctiveScore: number;
  matchedCount: number;
  tokenCount: number;
}

function scoreAsset(emitter: EmitterAsset, tokens: BlockToken[]): AssetScore {
  let score = 0;
  let matchedDistinctive = 0;
  let distinctiveScore = 0;
  let matchedCount = 0;
  for (const t of tokens) {
    if (!emitter.haystacks.some((h) => h.includes(t.literal))) continue;
    score += t.weight;
    matchedCount++;
    if (!t.common) {
      matchedDistinctive++;
      distinctiveScore += t.weight;
    }
  }
  return {
    emitter,
    score,
    matchedDistinctive,
    distinctiveScore,
    matchedCount,
    tokenCount: tokens.length,
  };
}

/** Minimum overlap score for a "likely" theme attribution (≈ one solid distinctive token). */
const MIN_LIKELY_SCORE = 8;
/** Best asset must lead the runner-up by this factor, else the match is ambiguous. */
const AMBIGUITY_LEAD = 1.5;
/**
 * Candidate bar: a single short shared literal (e.g. the shop name appearing in
 * BOTH an app-injected block and a theme block) is noise, not evidence of
 * emission. An asset only counts as a candidate with ≥2 distinctive matches,
 * or ONE very strong one (a long literal like a full URL is near-conclusive).
 */
const MIN_DISTINCTIVE_MATCHES = 2;
const STRONG_DISTINCTIVE_SCORE = 20;

function isCandidate(s: AssetScore): boolean {
  return (
    s.matchedDistinctive >= MIN_DISTINCTIVE_MATCHES ||
    s.distinctiveScore >= STRONG_DISTINCTIVE_SCORE
  );
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function result(
  block: RenderedJsonLdBlock,
  source: string,
  confidence: SchemaSourceConfidence,
  matchedBy: string,
  assetKey?: string
): SchemaSourceResult {
  return {
    position: block.position,
    source,
    ...(assetKey !== undefined ? { assetKey } : {}),
    confidence,
    matchedBy,
  };
}

function sourceFor(key: string): { source: string; assetKey: string } {
  return key === SCHEMAGEN_SNIPPET_KEY
    ? { source: "schemagen", assetKey: key }
    : { source: `theme:${key}`, assetKey: key };
}

function classifyBlock(
  block: RenderedJsonLdBlock,
  emitters: EmitterAsset[]
): SchemaSourceResult {
  const normRaw = normalizeWs(block.raw);
  if (normRaw.length === 0) {
    return result(block, "unknown", "none", "empty block");
  }

  // 1. Verbatim (whitespace-normalized) containment — a fully static emission.
  //    The schemagen snippet is also checked through its unescaped form because
  //    renderScript stores `<` / `{` as JSON unicode escapes.
  for (const e of emitters) {
    if (e.normHaystacks.some((h) => h.includes(normRaw))) {
      const { source, assetKey } = sourceFor(e.key);
      return result(
        block,
        source,
        "exact",
        e.key === SCHEMAGEN_SNIPPET_KEY
          ? "block embedded verbatim in the SchemaGen managed snippet"
          : `block appears verbatim (static) in ${e.key}`,
        assetKey
      );
    }
  }

  // 2. Static-literal overlap. Only assets clearing the distinctive-evidence
  //    bar count as candidates — overlap on universal scaffolding
  //    (`"@type"`, `"name"`, …) or a single short shared value is not
  //    evidence of emission (see isCandidate).
  //
  //    The schemagen snippet is EXCLUDED here: it describes the same products
  //    the theme does, so a theme-native block shares most of its distinctive
  //    literals (title, price, URLs) with our snippet. Fuzzy overlap with our
  //    own snippet proves "same product", not "we emitted it" — only the
  //    verbatim check above may classify a block as schemagen.
  const tokens = extractTokens(block.raw);
  const candidates = emitters
    .filter((e) => e.key !== SCHEMAGEN_SNIPPET_KEY)
    .map((e) => scoreAsset(e, tokens))
    .filter(isCandidate)
    .sort((a, b) => b.score - a.score);

  const [best, second] = candidates;
  const clearWinner =
    best !== undefined &&
    best.score >= MIN_LIKELY_SCORE &&
    (second === undefined || best.score >= second.score * AMBIGUITY_LEAD);

  if (clearWinner) {
    const { source, assetKey } = sourceFor(best.emitter.key);
    return result(
      block,
      source,
      "likely",
      `static-literal overlap with ${best.emitter.key} ` +
        `(${best.matchedCount}/${best.tokenCount} tokens, score ${best.score})`,
      assetKey
    );
  }

  // 3. Filter-based emission: Shopify's `| structured_data` filter renders the
  //    whole JSON-LD block at runtime, so NO literal overlap exists with the
  //    emitting asset. Match by object kind instead: a Product/ProductGroup
  //    block on a theme whose sections call `{{ … product … | structured_data }}`
  //    came from one of those sections. The Liquid expression itself is the
  //    suppression needle (it sits inside the emitting <script> element).
  const kind = blockFilterKind(block);
  if (kind) {
    const filterEmitters = emitters
      .filter((e) => e.filterExpressions.some((f) => f.kind === kind))
      .map((e) => ({
        assetKey: e.key,
        needle: e.filterExpressions.find((f) => f.kind === kind)!.expression,
      }))
      .sort((a, b) => a.assetKey.localeCompare(b.assetKey));
    if (filterEmitters.length > 0) {
      const [first, ...rest] = filterEmitters;
      return {
        ...result(
          block,
          `theme:${first.assetKey}`,
          "likely",
          `structured_data filter emission (${kind}): ${first.needle} in ${first.assetKey}` +
            (rest.length ? ` (+${rest.length} more emitters)` : ""),
          first.assetKey
        ),
        needle: first.needle,
        ...(rest.length ? { alsoEmittedBy: rest } : {}),
      };
    }
  }

  if (candidates.length === 0) {
    return result(
      block,
      "external",
      "none",
      "no theme asset shares this block's static literals — app/ScriptTag injected"
    );
  }

  const detail = second
    ? `ambiguous overlap: ${best.emitter.key} (score ${best.score}) vs ` +
      `${second.emitter.key} (score ${second.score})`
    : `weak overlap with ${best.emitter.key} (score ${best.score} < ${MIN_LIKELY_SCORE})`;
  return result(block, "unknown", "none", detail);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LocateSchemaSourcesParams {
  themeId: number;
  renderedBlocks: RenderedJsonLdBlock[];
  ops: SourceLocatorOps;
}

/**
 * Classify the origin of every JSON-LD block extracted from a rendered page.
 * Theme assets are fetched once per (ops, themeId) and cached, so calling this
 * for every page of a site crawl costs one theme scan total.
 */
export async function locateSchemaSources(
  params: LocateSchemaSourcesParams
): Promise<SchemaSourceResult[]> {
  const { themeId, renderedBlocks, ops } = params;
  const emitters = await loadEmitters(ops, themeId);
  return renderedBlocks.map((block) => classifyBlock(block, emitters));
}

/** Production SourceLocatorOps over the real Asset API (per-shop via ctx). */
export function makeSourceLocatorOps(ctx?: ShopContext): SourceLocatorOps {
  return {
    assetsList: (themeId) => assetsList(themeId, ctx),
    assetGet: (themeId, key) => assetGet(themeId, key, ctx),
  };
}
