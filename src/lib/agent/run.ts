/**
 * runGoal — the agent loop entry point (plan §3). Perceive → plan → act, in
 * dry-run. The LLM only runs inside the executor's processPage("optimize"); the
 * planner and every gate are deterministic. Nothing is written to Shopify in
 * Phase 2 — the staged snippet that *would* be written is returned for diffing.
 */
import { processPage } from "@/lib/crawl/process-page";
import { fetchSitemap } from "@/lib/crawl/sitemap";
import { fetchPage } from "@/lib/url-validator/fetcher";
import { createAdminClient } from "@/lib/supabase";
import { getRichResultInfo } from "@/lib/validation/rich-results";
import { typeSatisfies } from "@/lib/validation/schema-definitions";
import { validateSchema } from "@/lib/validation/engine";
import { renderSchemaGenSnippet, urlToTemplateTarget } from "@/lib/shopify/snippet";
import { getShopifyConfig, normalizeShop } from "@/lib/shopify/config";
import type { SnippetEntry } from "@/lib/shopify/snippet";
import type { PageResult } from "@/lib/crawl/types";
import { resolveShopContext } from "@/lib/shopify/credentials";
import {
  prepareStagingTheme,
  themeDelete,
  themePublish,
  themesList,
} from "@/lib/shopify/themes";
import {
  locateSchemaSources,
  makeSourceLocatorOps,
  type SourceLocatorOps,
} from "@/lib/shopify/source-locator";
import type { ShopContext } from "@/lib/shopify/types";
import type { ExtractedJsonLd } from "@/lib/url-validator/types";
import { planTasks } from "./planner";
import { executeTask } from "./executor";
import { hasCriticalIssue } from "./gates";
import { l4Verify } from "./verify";
import {
  applyEntries,
  makeShopifyOps,
  type ApplyItem,
  type ApplySuppression,
  type VerifyContext,
} from "./apply";
import {
  getStorefrontCookie,
  isStorefrontPasswordConfigured,
  looksPasswordGated,
} from "@/lib/shopify/storefront-password";
import {
  makeBreakers,
  recordOutcome,
  recordRollbackFailure,
  tripped,
} from "./breakers";
import {
  createRun,
  finishRun,
  loadCommittedUrls,
  recordAction,
  saveResolvedUrls,
} from "./audit";
import { chunk, clampConcurrency } from "./concurrency";
import {
  classifyPageType,
  PAGE_TYPE_PRIORITY,
  requirementsForTarget,
  type PageType,
} from "./page-type-matrix";
import { enumerateCatalogUrls } from "./catalog";

function warn(msg: string, e: unknown): void {
  console.warn(`[agent] ${msg}: ${e instanceof Error ? e.message : String(e)}`);
}
import type {
  ActionRecord,
  AgentProgressEvent,
  ApplyResult,
  BreakerReason,
  Goal,
  GoalTarget,
  PerceivedPage,
  RunOptions,
  RunResult,
  StagingOutcome,
  WriteThemeStrategy,
} from "./types";

/** Per-site Shopify context (issue #25), as resolveShopContext shapes it. */
type SiteShopContext = ShopContext & { storefrontPassword: string | null };

/** Build a perceived-state record from a no-LLM scan of one page. */
function toPerceived(goal: Goal, url: string, scan: PageResult): PerceivedPage {
  const hadSchema = (scan.originalSchemas?.length ?? 0) > 0;
  const errorCount = scan.validationResults?.errorCount ?? 0;

  // This page's required types with their per-type bars (issue #28): matrix-driven
  // for scope "site", the goal's uniform requireTypes @ minOutcome otherwise.
  const requirements = requirementsForTarget(goal.target, url);

  const validSchemas = (scan.validationResults?.schemas ?? []).filter(
    (s) => s.validation.valid
  );
  // Subtype-aware (an AboutPage satisfies a WebPage requirement) — must agree with
  // the L1/L2/L4 gates' schemaSatisfiesType so a satisfied page is never re-queued.
  const typesOk = requirements.every((r) =>
    validSchemas.some((s) => typeSatisfies(s.type, r.type))
  );

  // rich-results skip path must match the L2 gate exactly: a rich-bar type must
  // be rich-eligible AND every live valid schema of that type must be free of
  // critical-impact issues. Otherwise a page L2 would reject could be skipped.
  const richOk = requirements.every((r) => {
    if (r.outcome !== "rich_results_eligible") return true;
    if (getRichResultInfo(r.type)?.eligible !== true) return false;
    const ofType = validSchemas.filter((s) => typeSatisfies(s.type, r.type));
    return (
      ofType.length > 0 && ofType.every((s) => !hasCriticalIssue(s.validation))
    );
  });

  return {
    url,
    status: scan.status,
    errorCount,
    hadSchema,
    satisfied: scan.status === "valid" && typesOk && richOk,
    requirements,
    // Carried for authoritative mode (issue #23): the source locator classifies the
    // origin of each live block without re-fetching the page.
    renderedBlocks: scan.renderedBlocks ?? null,
  };
}

/**
 * Best-effort snapshot row into theme_backups (the durable rollback record, keyed by
 * run). The in-memory pre-write value is the operative rollback token, so a failed
 * insert is logged and swallowed — it must never abort or corrupt the apply.
 */
async function backupRow(
  runId: string | null,
  shop: string,
  themeId: number,
  assetKey: string,
  valueBefore: string | null
): Promise<void> {
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from("theme_backups").insert({
      run_id: runId,
      shop,
      theme_id: themeId,
      asset_key: assetKey,
      asset_value_before: valueBefore ?? "",
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    warn("theme_backups insert failed (continuing)", e);
  }
}

async function getSiteRow(
  siteId: string
): Promise<{ domain: string; shopDomain: string | null }> {
  const supabase = createAdminClient();
  let { data, error } = await supabase
    .from("sites")
    .select("domain, shop_domain")
    .eq("id", siteId)
    .single();
  // Pre-migration-009 installs have no sites.shop_domain column. Degrade to the
  // domain-only select (per-site Shopify context simply stays unavailable) instead
  // of failing the whole run on a schema-version mismatch.
  if (error?.message?.includes("shop_domain")) {
    warn("sites.shop_domain missing (migration 009 not applied); per-site context disabled", error.message);
    ({ data, error } = await supabase
      .from("sites")
      .select("domain")
      .eq("id", siteId)
      .single());
  }
  if (error || !data) {
    throw new Error(`Could not resolve site domain for ${siteId}: ${error?.message}`);
  }
  const row = data as { domain: string; shop_domain?: string | null };
  return { domain: row.domain, shopDomain: row.shop_domain ?? null };
}

/**
 * Resolve the goal's scope into a concrete URL list (issue #27).
 *
 * "site" / "all_pages": classify every sitemap URL against the page-type matrix and
 * keep the kinds the matrix covers (home/product/collection/article/page), ordered by
 * the DETERMINISTIC page-type priority (home first, then products, collections,
 * articles, pages; stable within a kind) so a maxPages-capped run always covers the
 * most valuable pages. When the sitemap yields nothing (password-gated dev store), the
 * Admin-API catalog fallback enumerates products + collections — gated on the site's
 * Shopify credentials actually resolving (enumerateCatalogUrls degrades to []).
 */
async function resolveTargetUrls(
  goal: Goal,
  preloadedSite: { domain: string; shopDomain: string | null } | null = null
): Promise<string[]> {
  if (goal.target.scope === "url_list") {
    return goal.target.urls ?? [];
  }
  // The orchestrator preloads the site row for the per-site context (issue #25);
  // when its best-effort lookup failed, retry here so the pre-#25 error behavior
  // ("Could not resolve site domain…") for site-scoped goals is preserved.
  const site = preloadedSite ?? (await getSiteRow(goal.siteId));
  const { urls } = await fetchSitemap(site.domain);
  let candidates = urls.map((u) => u.loc);

  if (goal.target.scope === "all_products") {
    return candidates.filter(
      (u) => urlToTemplateTarget(u)?.template === "product"
    );
  }

  // site / all_pages: Admin-API fallback only when the sitemap gave nothing.
  if (candidates.length === 0) {
    candidates = await enumerateCatalogUrls(site.domain, site.shopDomain);
  }

  const classified = candidates
    .map((url) => ({ url, pageType: classifyPageType(url) }))
    .filter((c): c is { url: string; pageType: PageType } => c.pageType !== null);

  // A "site" goal always includes the homepage, even when the sitemap omits "/".
  // Only synthesized when something else resolved — an empty resolution (gated
  // store, no credentials) must stay empty rather than chase a password wall.
  if (
    goal.target.scope === "site" &&
    classified.length > 0 &&
    !classified.some((c) => c.pageType === "home")
  ) {
    classified.unshift({ url: `https://${site.domain}/`, pageType: "home" });
  }

  const ordered = classified
    .map((c, i) => ({ ...c, i }))
    .sort(
      (a, b) =>
        PAGE_TYPE_PRIORITY[a.pageType] - PAGE_TYPE_PRIORITY[b.pageType] ||
        a.i - b.i
    )
    .map((c) => c.url);

  const cap = goal.constraints.maxPages;
  return cap != null ? ordered.slice(0, cap) : ordered;
}

/**
 * Resolve the theme the live apply writes to. Per CLAUDE.md, the agent only ever
 * touches SHOPIFY_TEST_THEME_ID (or a duplicate) — never the published live theme.
 * Absent/invalid env is a hard error so a live run can't silently target the wrong theme.
 */
function resolveWriteThemeId(): number {
  const raw = process.env.SHOPIFY_TEST_THEME_ID;
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) {
    throw new Error(
      "Live apply requires a valid SHOPIFY_TEST_THEME_ID (never the published theme)"
    );
  }
  return id;
}

/**
 * L4 verify wired to the real page fetcher. The staged (unpublished) theme is rendered
 * via Shopify's `?preview_theme_id=` param, so verification reads the exact bytes the
 * write produced, not the currently-published theme.
 */
function makeLiveVerify(
  target: GoalTarget,
  themeId: number,
  shop: string,
  /**
   * Per-site storefront password (issue #25). `undefined` keeps the env behavior
   * (SHOPIFY_STOREFRONT_PASSWORD); a string authenticates with THAT password; null
   * means "per-site context with no password" — never fall back to the env one,
   * storefront passwords are store-specific.
   */
  storefrontPassword?: string | null
) {
  const perSite = storefrontPassword !== undefined;
  // Dev stores (and any store with the storefront password on) redirect every
  // unauthenticated request to /password, so L4 would never see the rendered schema.
  // Obtain the storefront_digest cookie once (when a password is configured)
  // and send it on every verify fetch so the real page renders.
  let cookiePromise: Promise<string | null> | null = null;
  const getCookie = () => {
    if (!cookiePromise) {
      cookiePromise = perSite
        ? storefrontPassword
          ? getStorefrontCookie(shop, storefrontPassword)
          : Promise.resolve(null)
        : getStorefrontCookie(shop);
    }
    return cookiePromise;
  };
  const passwordConfigured = () =>
    perSite ? storefrontPassword != null : isStorefrontPasswordConfigured();

  return (url: string, _entry: SnippetEntry, ctx?: VerifyContext) => {
    void _entry;
    const previewUrl = `${url}${url.includes("?") ? "&" : "?"}preview_theme_id=${themeId}`;
    // Per-page requirements (issue #28): L4 must demand exactly what L1/L2 demanded
    // for THIS page's type, not one global type set.
    const requirements = requirementsForTarget(target, url);
    return l4Verify({
      url: previewUrl,
      requireTypes: requirements.map((r) => r.type),
      minOutcome: target.minOutcome,
      requirements,
      // Duplicate-prevention gate (issue #24): on whenever the apply carries
      // suppressions — apply.ts sets ctx.unique, we just forward it.
      unique: ctx?.unique ?? false,
      fetchHtml: async (u) => {
        const cookie = await getCookie();
        const r = await fetchPage(u, cookie ? { headers: { Cookie: cookie } } : {});
        if (r.error || !r.html) throw new Error(r.error ?? "empty response");
        // Turn the silent "no JSON-LD rendered" rollback into an actionable cause when
        // the storefront is password-gated and we couldn't authenticate past it.
        if (looksPasswordGated(r.finalUrl, r.html)) {
          throw new Error(
            passwordConfigured()
              ? perSite
                ? "storefront is password-protected and the site's configured storefront password was rejected"
                : "storefront is password-protected and the configured SHOPIFY_STOREFRONT_PASSWORD was rejected"
              : "storefront is password-protected — set SHOPIFY_STOREFRONT_PASSWORD (Online Store → Preferences) or disable the storefront password so the live page can be verified"
          );
        }
        return r.html;
      },
    });
  };
}

/**
 * Name for the staging duplicate (issue #26). Date-stamped (day granularity) so a
 * merchant browsing Online Store → Themes can tell runs apart; tests assert the
 * stable prefix only, so the date never makes a test flaky.
 */
function stagingThemeName(): string {
  return `SchemaGen Staging ${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Theme to classify block origins against for a DRY-RUN authoritative analysis
 * (no write target exists yet). The published theme is the right reference — it is
 * exactly what staging mode would duplicate — with the env test theme as fallback.
 * null = no theme resolvable; the analysis is skipped (best-effort early warning).
 */
async function resolveAnalysisThemeId(
  ctx: SiteShopContext | null
): Promise<number | null> {
  try {
    const themes = await themesList(ctx ?? undefined);
    const main = themes.find((t) => t.role === "main");
    if (main) return main.id;
  } catch (e) {
    warn("themesList failed for dry-run authoritative analysis", e);
  }
  try {
    return resolveWriteThemeId();
  } catch {
    return null;
  }
}

/** All @type values declared by a parsed JSON-LD block (walks arrays + @graph). */
function blockSchemaTypes(parsed: unknown): string[] {
  const types = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (v === null || typeof v !== "object") return;
    const obj = v as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") types.add(t);
    else if (Array.isArray(t)) {
      for (const x of t) if (typeof x === "string") types.add(x);
    }
    if (Array.isArray(obj["@graph"])) visit(obj["@graph"]);
  };
  visit(parsed);
  return [...types];
}

const QUOTED_LITERAL_RE = /"(?:[^"\\\n]|\\.)*"/g;

/**
 * Pick the `contains` needle a suppression will use to find the emitting script
 * element inside the theme asset (suppress.ts matches script-range text).
 *
 * THE CHOICE: quoted string literals are what survive Liquid templating, so the
 * needle is the LONGEST quoted literal of the rendered block (quotes included —
 * `"https://schema.org/InStock"` style) that ALSO appears verbatim in the asset's
 * text; a long shared literal is near-conclusive and stable across re-renders.
 * When the asset text is unavailable, fall back to the longest literal outright —
 * if it turns out not to match, suppressJsonLdEmission fails closed and apply.ts
 * records a not_suppressible merchant_action instead of touching the asset.
 * Ties break on first occurrence (Array.prototype.sort is stable). Returns
 * undefined only when the block has no usable quoted literal at all.
 */
function pickContainsLiteral(
  raw: string,
  assetText: string | null
): string | undefined {
  const literals = [...new Set(raw.match(QUOTED_LITERAL_RE) ?? [])].filter(
    (l) => l.length >= 4 // at least 2 inner chars — single chars prove nothing
  );
  literals.sort((a, b) => b.length - a.length);
  if (assetText) {
    const inAsset = literals.find((l) => assetText.includes(l));
    if (inAsset) return inAsset;
  }
  return literals[0];
}

/**
 * Authoritative suppression plan (issue #23). For every page that staged an entry,
 * classify the origin of each live JSON-LD block (source locator; one theme scan
 * total thanks to its per-ops cache) and decide:
 *
 *   schemagen           → ours; never suppress.
 *   theme:<asset_key>   → COMPETES (declared type intersects the page's required
 *                         types — subtype-aware — OR the block is unparseable OR
 *                         parsed-but-invalid: under authoritative mode every
 *                         broken theme emission is ours to silence, whatever its
 *                         type) → suppression {assetKey, match:{contains}, url}.
 *                         The locator's needle (the structured_data filter
 *                         expression for render-time emissions) wins over the
 *                         literal-overlap fallback, and co-emitting filter
 *                         assets (alsoEmittedBy) are suppressed too.
 *   external / unknown  → not removable via theme edits → merchant_action row
 *                         `external_schema:<type|unparseable>:<url>` (deduped).
 *
 * Suppressions are deduped by assetKey+needle. The plan only PLANS — apply.ts
 * executes it inside the backup → write → verify → rollback envelope.
 */
async function buildSuppressionPlan(args: {
  themeId: number;
  pages: { url: string; blocks: ExtractedJsonLd[] }[];
  target: GoalTarget;
  ops: SourceLocatorOps;
}): Promise<{ suppressions: ApplySuppression[]; merchantRows: ActionRecord[] }> {
  const suppressions: ApplySuppression[] = [];
  const merchantRows: ActionRecord[] = [];
  const seenSuppression = new Set<string>();
  const seenMerchant = new Set<string>();
  const assetTextCache = new Map<string, string | null>();
  const getAssetText = async (key: string): Promise<string | null> => {
    if (!assetTextCache.has(key)) {
      try {
        assetTextCache.set(
          key,
          (await args.ops.assetGet(args.themeId, key)).value ?? null
        );
      } catch (e) {
        warn(`could not fetch ${key} for suppression-needle selection`, e);
        assetTextCache.set(key, null);
      }
    }
    return assetTextCache.get(key) ?? null;
  };
  const merchantRow = (url: string, outcome: string): void => {
    if (seenMerchant.has(outcome)) return;
    seenMerchant.add(outcome);
    merchantRows.push({
      url,
      action: "merchant_action",
      schemaBefore: null,
      schemaAfter: null,
      gates: null,
      outcome,
    });
  };

  for (const page of args.pages) {
    const requiredTypes = new Set(
      requirementsForTarget(args.target, page.url).map((r) => r.type)
    );
    const located = await locateSchemaSources({
      themeId: args.themeId,
      renderedBlocks: page.blocks,
      ops: args.ops,
    });
    for (let i = 0; i < page.blocks.length; i++) {
      const block = page.blocks[i];
      const res = located[i];
      if (!res || res.source === "schemagen") continue;
      const unparseable = !!block.parseError || block.parsed == null;
      const types = unparseable ? [] : blockSchemaTypes(block.parsed);

      if (res.source.startsWith("theme:") && res.assetKey) {
        // Subtype-aware intersection, plus: any unparseable OR parsed-but-invalid
        // theme block is competing markup — authoritative mode owns every broken
        // theme emission, whatever its type (the dev-store ProductGroup case).
        const invalid =
          !unparseable &&
          !validateSchema(block.parsed as Record<string, unknown>).valid;
        const competes =
          unparseable ||
          invalid ||
          types.some((t) =>
            [...requiredTypes].some((req) => typeSatisfies(t, req))
          );
        if (!competes) continue;
        // Co-emitting structured_data filter assets render the same competing
        // markup from other sections — suppress them with their own expressions.
        for (const extra of res.alsoEmittedBy ?? []) {
          const k = `${extra.assetKey} ${extra.needle}`;
          if (seenSuppression.has(k)) continue;
          seenSuppression.add(k);
          suppressions.push({
            assetKey: extra.assetKey,
            match: { contains: extra.needle },
            url: page.url,
          });
        }
        // The locator's needle (the filter expression living inside the emitting
        // script element) beats literal-overlap needle selection.
        const needle =
          res.needle ??
          pickContainsLiteral(block.raw, await getAssetText(res.assetKey));
        if (!needle) {
          merchantRow(
            page.url,
            `not_suppressible:${res.assetKey}:no stable literal in the rendered block`
          );
          continue;
        }
        const dedupe = `${res.assetKey} ${needle}`;
        if (seenSuppression.has(dedupe)) continue;
        seenSuppression.add(dedupe);
        suppressions.push({
          assetKey: res.assetKey,
          match: { contains: needle },
          url: page.url,
        });
        continue;
      }

      // external (app/ScriptTag) or unknown (ambiguous evidence): never acted on,
      // surfaced as a required merchant action — once per distinct block.
      const label = unparseable ? "unparseable" : (types[0] ?? "unknown");
      merchantRow(page.url, `external_schema:${label}:${page.url}`);
    }
  }
  return { suppressions, merchantRows };
}

export async function runGoal(
  goal: Goal,
  opts: RunOptions = {}
): Promise<RunResult> {
  const dryRun = opts.dryRun ?? true;
  const persistAudit = opts.persistAudit ?? true;
  const concurrency = clampConcurrency(opts.concurrency);
  const resume = opts.resume ?? true;
  const judge = opts.judge ?? false;
  // Live-apply write strategy (issue #26). Default "env" = pre-staging behavior.
  const writeTheme: WriteThemeStrategy = opts.writeTheme ?? { mode: "env" };
  // Authoritative override (issue #23): defaults ON for whole-site goals only, so
  // every non-site goal keeps its pre-#23 behavior unless explicitly opted in.
  const authoritative =
    goal.constraints.authoritative ?? goal.target.scope === "site";
  const breakers = makeBreakers({
    maxCostUsd: goal.constraints.maxCostUsd,
    ...opts.breakers,
  });

  // Audit is best-effort: a failing audit write must never abort or corrupt the
  // analysis. A caller-supplied runId (the control surface creates the run first so it
  // can poll control immediately) is used as-is; otherwise createRun failure degrades to
  // an unaudited run rather than throwing.
  let runId: string | null = opts.runId ?? null;
  if (persistAudit && !runId) {
    try {
      runId = await createRun(goal);
    } catch (e) {
      warn("createRun failed; continuing without audit", e);
    }
  }
  const actions: ActionRecord[] = [];
  let pagesTouched = 0;
  const record = async (a: ActionRecord) => {
    actions.push(a);
    if (runId) {
      try {
        await recordAction(runId, a);
      } catch (e) {
        warn("recordAction failed", e);
      }
    }
  };

  // Progress is best-effort: a throwing onProgress must never abort the run.
  const emit = (ev: AgentProgressEvent) => {
    if (!opts.onProgress) return;
    try {
      opts.onProgress(ev);
    } catch (e) {
      warn("onProgress threw (continuing)", e);
    }
  };
  // Cooperative cancellation. A thrown shouldHalt is treated as "not killed" (a transient
  // control-read error must not halt a healthy run; readControl already swallows its own).
  const killRequested = async (): Promise<boolean> => {
    if (opts.signal?.aborted) return true;
    if (opts.shouldHalt) {
      try {
        return (await opts.shouldHalt()) === "kill";
      } catch (e) {
        warn("shouldHalt threw (continuing)", e);
        return false;
      }
    }
    return false;
  };

  try {
    // PER-SITE SHOPIFY CONTEXT (issue #25): when the site row names a shop_domain,
    // resolve its credentials ONCE and thread the resulting ShopContext through every
    // Shopify surface this run touches (asset ops, staging/publish, source locator,
    // storefront cookie). Best-effort: a missing site row or unresolvable credentials
    // degrade to the env-configured single-store behavior, byte-identical to pre-#25.
    let siteRow: { domain: string; shopDomain: string | null } | null = null;
    try {
      siteRow = await getSiteRow(goal.siteId);
    } catch (e) {
      warn("site lookup failed; per-site Shopify context unavailable", e);
    }
    let shopCtx: SiteShopContext | null = null;
    if (siteRow?.shopDomain) {
      try {
        shopCtx = await resolveShopContext(siteRow.shopDomain);
      } catch (e) {
        warn(
          `could not resolve Shopify credentials for ${siteRow.shopDomain}; using env`,
          e
        );
      }
    }

    // PERCEIVE — no LLM. A kill between batches stops here; nothing has been written.
    let urls = await resolveTargetUrls(goal, siteRow);

    // Persist the resolved target list (issue #27) so the merchant report can compute
    // notReached exactly for any scope. Best-effort, like every other audit write.
    if (runId) {
      try {
        await saveResolvedUrls(runId, urls);
      } catch (e) {
        warn("saveResolvedUrls failed (continuing)", e);
      }
    }

    // Idempotent resume (Phase 5): drop pages this run already committed live (an
    // l4_pass verify row). A resumed run never re-processes them; a fresh run has none,
    // so this is inert. Best-effort — loadCommittedUrls degrades to empty on any error.
    const committedSkipped: string[] = [];
    if (resume && runId) {
      const committed = await loadCommittedUrls(runId);
      if (committed.size > 0) {
        for (const u of urls) {
          if (!committed.has(u)) continue;
          committedSkipped.push(u);
          await record({
            url: u,
            action: "skip",
            schemaBefore: null,
            schemaAfter: null,
            gates: null,
            outcome: "already_committed",
          });
        }
        urls = urls.filter((u) => !committed.has(u));
      }
    }

    // Storefront-password auth for perceive + execute. A Shopify dev store (or any store
    // with "Password protect this store" on) 302-redirects every storefront request to
    // /password, so processPage would only ever see the password wall. Obtain the
    // storefront_digest cookie once (same one L4 verify uses; getStorefrontCookie caches
    // per-shop in-process) and attach it ONLY to fetches on the configured shop host —
    // public sites in the goal are still fetched anonymously. Best-effort: no password
    // configured, or any failure, degrades to anonymous fetches (the prior behavior).
    let shopHost = "";
    let storefrontCookie: string | null = null;
    try {
      if (shopCtx) {
        // Per-site context (issue #25): use the site's own storefront password —
        // never the env one, storefront passwords are store-specific.
        shopHost = normalizeShop(shopCtx.shop);
        storefrontCookie = shopCtx.storefrontPassword
          ? await getStorefrontCookie(shopCtx.shop, shopCtx.storefrontPassword)
          : null;
      } else {
        shopHost = normalizeShop(getShopifyConfig().shop);
        storefrontCookie = await getStorefrontCookie(getShopifyConfig().shop);
      }
    } catch {
      shopHost = "";
      storefrontCookie = null;
    }
    const headersFor = (u: string): Record<string, string> | undefined => {
      if (!storefrontCookie || !shopHost) return undefined;
      try {
        if (normalizeShop(new URL(u).hostname) === shopHost) {
          return { Cookie: storefrontCookie };
        }
      } catch {
        /* unparseable URL → fetch anonymously */
      }
      return undefined;
    };

    emit({ phase: "perceive", runId, perceived: 0, queued: 0 });
    const perceived: PerceivedPage[] = [];
    let killed = false;
    // Bounded fan-out: scan up to `concurrency` pages at once, fold results in order so
    // progress events stay deterministic. Kill is honored before each batch.
    for (const batch of chunk(urls, concurrency)) {
      if (await killRequested()) {
        killed = true;
        break;
      }
      const scans = await Promise.all(
        batch.map((u) => processPage(u, "scan", undefined, { fetchHeaders: headersFor(u) }))
      );
      for (let i = 0; i < batch.length; i++) {
        perceived.push(toPerceived(goal, batch[i], scans[i]));
        emit({ phase: "perceive", url: batch[i], perceived: perceived.length });
      }
    }

    // PLAN + ACT only run if we weren't killed during perceive.
    const satisfied: string[] = [...committedSkipped];
    const unsatisfied: string[] = [];
    const entries: SnippetEntry[] = [];
    const applyItems: ApplyItem[] = [];
    let skipped: string[] = [...committedSkipped];
    let haltedBy: BreakerReason | undefined;

    if (!killed) {
      // PLAN — deterministic.
      const planned = planTasks(goal, perceived);
      skipped = [...committedSkipped, ...planned.skipped];
      satisfied.push(...planned.skipped);
      emit({
        phase: "plan",
        queued: planned.queue.length,
        satisfied: satisfied.length,
      });
      for (const url of planned.skipped) {
        await record({
          url,
          action: "skip",
          schemaBefore: null,
          schemaAfter: null,
          gates: null,
          outcome: "already_satisfied",
        });
      }

      // ACT — stage + gate each queued page, up to `concurrency` at a time. Results are
      // folded in queue order, so the consecutive-failure breaker behaves exactly as it
      // did sequentially. A breaker trip OR a kill halts the loop early — both before any
      // live write. Kill is honored before each batch (per-batch granularity); the
      // load-bearing pre-apply checkpoint still guarantees no half-written theme.
      for (const batch of chunk(planned.queue, concurrency)) {
        if (await killRequested()) {
          killed = true;
          break;
        }
        const results = await Promise.all(
          batch.map((task) =>
            executeTask(goal, task, { judge, fetchHeaders: headersFor(task.url) })
          )
        );
        let halted = false;
        for (const ex of results) {
          pagesTouched += 1;
          await record(ex.action);
          if (ex.satisfied) {
            satisfied.push(ex.url);
            if (ex.entry) {
              entries.push(ex.entry);
              applyItems.push({ url: ex.url, entry: ex.entry });
            }
          } else {
            unsatisfied.push(ex.url);
          }
          emit({
            phase: "act",
            url: ex.url,
            gates: ex.action.gates,
            outcome: ex.action.outcome,
            // The repaired JSON-LD this page would inject — surfaced inline so the UI can
            // show a per-product schema dropdown in the preview.
            schemaAfter: ex.action.schemaAfter,
            acted: pagesTouched,
            satisfied: satisfied.length,
            unsatisfied: unsatisfied.length,
          });

          recordOutcome(breakers, {
            success: ex.satisfied,
            costUsd: ex.action.costUsd ?? 0,
          });
          const verdict = tripped(breakers);
          if (verdict.halted) {
            haltedBy = verdict.reason;
            warn("circuit breaker halted the run", verdict.detail ?? verdict.reason);
            halted = true;
            break;
          }
        }
        if (halted) break;
      }
    }

    const stagedSnippet = entries.length
      ? renderSchemaGenSnippet(entries)
      : null;

    // AUTHORITATIVE PLAN INPUT (issue #23): the staged pages whose live render carried
    // JSON-LD blocks the locator can classify. Empty when authoritative is off, when
    // nothing staged, or when no scan captured blocks — all of those skip the locator
    // entirely (no theme scan, no Admin API traffic).
    const perceivedByUrl = new Map(perceived.map((p) => [p.url, p]));
    const planPages = authoritative
      ? applyItems.flatMap((i) => {
          const blocks = perceivedByUrl.get(i.url)?.renderedBlocks;
          return blocks && blocks.length > 0 ? [{ url: i.url, blocks }] : [];
        })
      : [];

    // PRE-APPLY KILL CHECKPOINT (the load-bearing guarantee). The apply path is atomic
    // and is never interrupted once entered, so the ONLY safe place to honor a kill is
    // right here, before the first write. A kill caught here means nothing was written
    // and there is nothing to roll back — "kill leaves no half-written theme" by
    // construction.
    if (!killed && !haltedBy && !dryRun && applyItems.length > 0) {
      if (await killRequested()) killed = true;
    }

    // LIVE APPLY (Phase 3) — only when not dry-run, nothing halted us, not killed, and we
    // have verified-stageable entries. Dry-run returns here with apply:null, unchanged.
    let apply: ApplyResult | null = null;
    let staging: StagingOutcome | null = null;
    if (!dryRun && !haltedBy && !killed && applyItems.length > 0) {
      // STAGE (issue #26): duplicate the published theme and make it the write target.
      // SLOW — O(assets) Asset API calls — so progress goes out BEFORE the call, and
      // the preview URL goes out the moment the duplicate exists.
      if (writeTheme.mode === "staging") {
        emit({
          phase: "stage",
          runId,
          message: "duplicating the live theme — this can take a few minutes…",
        });
        const prepared = await prepareStagingTheme(
          undefined,
          stagingThemeName(),
          shopCtx ?? undefined
        );
        staging = { ...prepared, published: false };
        emit({
          phase: "stage",
          runId,
          previewUrl: prepared.previewUrl,
          message: `staging theme ${prepared.stagingThemeId} ready`,
        });
      }
      emit({ phase: "apply", queued: applyItems.length });
      // Staging mode writes to the fresh duplicate; env mode keeps the pre-#26 path
      // (including resolveWriteThemeId's hard error on a bad env id) byte-identical.
      const themeId = staging
        ? staging.stagingThemeId
        : resolveWriteThemeId();
      const shop = shopCtx?.shop ?? getShopifyConfig().shop;

      // AUTHORITATIVE SUPPRESSION PLAN (issue #23) — computed against the WRITE-TARGET
      // theme: the staging duplicate's assets are byte-identical to live (that's the
      // point), and in env mode the env theme IS what the suppressions must edit.
      // A plan failure here throws BEFORE the first write — fatal but safe.
      let suppressions: ApplySuppression[] = [];
      if (planPages.length > 0) {
        const plan = await buildSuppressionPlan({
          themeId,
          pages: planPages,
          target: goal.target,
          ops: makeSourceLocatorOps(shopCtx ?? undefined),
        });
        suppressions = plan.suppressions;
        for (const row of plan.merchantRows) await record(row);
      }

      apply = await applyEntries({
        runId,
        themeId,
        shop,
        items: applyItems,
        ops: makeShopifyOps(shopCtx ?? undefined),
        verify: makeLiveVerify(
          goal.target,
          themeId,
          shop,
          shopCtx ? shopCtx.storefrontPassword : undefined
        ),
        persistBackup: (assetKey, valueBefore) =>
          backupRow(runId, shop, themeId, assetKey, valueBefore),
        ...(suppressions.length > 0 ? { suppressions } : {}),
      });
      for (const a of apply.actions) await record(a);
      // A rollback that itself failed pages the user — never thrash on the next run.
      if (apply.status === "paged") recordRollbackFailure(breakers);
      emit({ phase: "apply", applyStatus: apply.status });

      // PUBLISH / CLEANUP (issue #26).
      if (staging) {
        if (
          apply.status === "applied" &&
          writeTheme.mode === "staging" &&
          writeTheme.publish
        ) {
          emit({
            phase: "publish",
            runId,
            message: `publishing staging theme ${staging.stagingThemeId}`,
          });
          try {
            await themePublish(staging.stagingThemeId, shopCtx ?? undefined);
            staging.published = true;
            staging.rollbackThemeId = staging.sourceThemeId;
            await record({
              url: applyItems[0]?.url ?? "",
              action: "publish",
              schemaBefore: null,
              schemaAfter: null,
              gates: null,
              outcome: `published:${staging.stagingThemeId} displaced:${staging.sourceThemeId}`,
              writeTarget: String(staging.stagingThemeId),
            });
          } catch (e) {
            // The verified staging theme is intact — the merchant can publish it
            // manually, so a failed swap degrades to a merchant action, not a throw.
            warn("themePublish failed; staging theme left unpublished", e);
            await record({
              url: applyItems[0]?.url ?? "",
              action: "merchant_action",
              schemaBefore: null,
              schemaAfter: null,
              gates: null,
              outcome: `publish_failed:${staging.stagingThemeId}:${e instanceof Error ? e.message : String(e)}`,
              writeTarget: String(staging.stagingThemeId),
            });
          }
        } else if (apply.status === "rolled_back") {
          // The rollback restored the duplicate byte-identical, so it holds no
          // evidence — delete it (best-effort) so failed runs don't pile up themes.
          try {
            await themeDelete(staging.stagingThemeId, shopCtx ?? undefined);
            staging.deleted = true;
          } catch (e) {
            warn(`failed to delete staging theme ${staging.stagingThemeId}`, e);
          }
        }
        // status "paged": the rollback FAILED — the staging theme is the only record
        // of what was written (the forensic evidence a human needs to finish the
        // restore by hand). NEVER delete it on a paged run.
      }
    } else if (dryRun && !haltedBy && !killed && planPages.length > 0) {
      // AUTHORITATIVE, DRY-RUN (issue #23): no theme is written, but block origins are
      // still classified so app-injected/external schema surfaces in the report EARLY
      // (the merchant can act before the live run). No suppression executes. Strictly
      // best-effort: any failure degrades to "no early warning", never a failed run.
      try {
        const analysisThemeId = await resolveAnalysisThemeId(shopCtx);
        if (analysisThemeId != null) {
          const plan = await buildSuppressionPlan({
            themeId: analysisThemeId,
            pages: planPages,
            target: goal.target,
            ops: makeSourceLocatorOps(shopCtx ?? undefined),
          });
          for (const row of plan.merchantRows) await record(row);
        }
      } catch (e) {
        warn("dry-run authoritative analysis failed (continuing)", e);
      }
    }

    // Map the run outcome. The persisted agent_runs.status is constrained to
    // done|failed; the richer RunResult.status (rolled_back/paged) is for callers. A kill
    // finalizes as failed but is surfaced separately via RunResult.killed.
    const ranClean = unsatisfied.length === 0 && !haltedBy && !killed;
    let status: RunResult["status"];
    if (apply && apply.status !== "applied") {
      status = apply.status === "paged" ? "paged" : "rolled_back";
    } else {
      status = ranClean ? "done" : "failed";
    }
    const dbStatus: "done" | "failed" = status === "done" ? "done" : "failed";
    const error =
      apply?.status === "paged"
        ? `rollback failed; theme left dirty: ${apply.error ?? "unknown"}`
        : killed
          ? "run killed by control signal"
          : haltedBy
            ? `halted by circuit breaker: ${haltedBy}`
            : null;

    if (runId) {
      try {
        await finishRun(runId, {
          status: dbStatus,
          iterations: 1,
          pagesTouched,
          costUsd: breakers.costUsd,
          error,
        });
      } catch (e) {
        warn("finishRun failed", e);
      }
    }

    emit({
      phase: "done",
      runId,
      applyStatus: apply?.status,
      satisfied: satisfied.length,
      unsatisfied: unsatisfied.length,
      message: killed ? "killed" : undefined,
    });

    return {
      runId,
      status,
      iterations: 1,
      pagesTouched,
      satisfied,
      unsatisfied,
      skipped,
      stagedSnippet,
      apply,
      haltedBy,
      killed,
      staging,
      actions,
    };
  } catch (err) {
    // A non-audit failure (e.g. resolveTargetUrls). Record real progress, don't
    // overwrite it with zeros, and don't let finishRun's own failure mask err.
    if (runId) {
      try {
        await finishRun(runId, {
          status: "failed",
          iterations: 1,
          pagesTouched,
          costUsd: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch (e) {
        warn("finishRun (failure path) failed", e);
      }
    }
    throw err;
  }
}
