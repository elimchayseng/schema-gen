/**
 * SMOKE E2E — the inner debug loop. ONE product page through the REAL pipeline
 * against the dev store, with loud per-step output, in ~1-2 min.
 *
 *   npm run smoke -- --url https://<shop>/products/<handle>            # live (writes test theme)
 *   npm run smoke -- --url https://<shop>/products/<handle> --dry-run  # no writes, ~30-60s
 *
 * Topology (env mode — the only mode this script uses):
 *   READ FROM   the published theme (plain product URL — before-state)
 *   INJECT TO   SHOPIFY_TEST_THEME_ID (must be unpublished; asserted below)
 *   VERIFY AT   <url>?preview_theme_id=<SHOPIFY_TEST_THEME_ID>
 *   The PLAIN product URL never changes in env mode. Check the VERIFY URL.
 *
 * Exit codes: 0 = pipeline green · 1 = pipeline failure · 2 = config/env error.
 */
import { runGoal } from "../src/lib/agent/run";
import { themesList } from "../src/lib/shopify/themes";
import { normalizeShop } from "../src/lib/shopify/config";
import { getStorefrontCookie } from "../src/lib/shopify/storefront-password";
import { fetchPage } from "../src/lib/url-validator/fetcher";
import { extractJsonLd } from "../src/lib/url-validator/extractor";
import { validateSchema } from "../src/lib/validation/engine";
import type { AgentProgressEvent, GateResults, Goal } from "../src/lib/agent/types";

const t0 = Date.now();
const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const stamp = () => `[${new Date().toISOString().slice(11, 19)} ${elapsed()}]`;
const log = (...a: unknown[]) => console.log(stamp(), ...a);

function fail(code: 1 | 2, msg: string): never {
  console.error(`\n${stamp()} ✗ FAIL: ${msg}`);
  process.exit(code);
}

function parseArgs(): { url: string; dryRun: boolean } {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const i = argv.indexOf("--url");
  const url = (i >= 0 ? argv[i + 1] : undefined) ?? process.env.SMOKE_PRODUCT_URL;
  if (!url || !url.startsWith("http")) {
    console.error(
      [
        "Usage: npm run smoke -- --url https://<shop>/products/<handle> [--dry-run]",
        "  (or set SMOKE_PRODUCT_URL in .env.local)",
        "Example:",
        "  npm run smoke -- --url https://ethan-dev-store-1.myshopify.com/products/selling-plans-ski-wax --dry-run",
      ].join("\n")
    );
    process.exit(2);
  }
  return { url, dryRun };
}

/** step runner: prints start/ok/FAIL with duration, collects a summary table. */
const summary: { step: string; ok: boolean; secs: string; note?: string }[] = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const s0 = Date.now();
  log(`▶ ${name} …`);
  try {
    const out = await fn();
    const secs = ((Date.now() - s0) / 1000).toFixed(1);
    summary.push({ step: name, ok: true, secs });
    log(`✓ ${name} (${secs}s)`);
    return out;
  } catch (e) {
    const secs = ((Date.now() - s0) / 1000).toFixed(1);
    const msg = e instanceof Error ? e.message : String(e);
    summary.push({ step: name, ok: false, secs, note: msg });
    log(`✗ ${name} (${secs}s): ${msg}`);
    throw e;
  }
}

function gateLine(g: GateResults | null | undefined): string {
  if (!g) return "(no gates)";
  const mark = (r: { passed: boolean } | null | undefined, name: string) =>
    r == null ? `${name}–` : `${name}${r.passed ? "✓" : "✗"}`;
  return [mark(g.L0, "L0"), mark(g.L1, "L1"), mark(g.L2, "L2"), mark(g.L3, "L3"), mark(g.L4, "L4")].join(" ");
}

function printJsonLd(label: string, blocks: { parsed: unknown; parseError?: string | null }[]) {
  console.log(`\n--- ${label}: ${blocks.length} JSON-LD block(s) ---`);
  for (const b of blocks) {
    if (b.parseError || b.parsed == null) {
      console.log(`  [unparseable] ${b.parseError ?? "no parse"}`);
      continue;
    }
    const type = (b.parsed as { "@type"?: unknown })["@type"] ?? "(no @type)";
    const v = validateSchema(b.parsed as Record<string, unknown>);
    const json = JSON.stringify(b.parsed, null, 2);
    console.log(`  @type=${JSON.stringify(type)} valid=${v.valid}${v.valid ? "" : ` errors=${v.errors.length}`}`);
    console.log(
      json.length > 2000 ? `${json.slice(0, 2000)}\n  … (${json.length - 2000} more chars)` : json
    );
  }
}

async function main() {
  const { url, dryRun } = parseArgs();

  // ---- step 1: env-check (pure, no network) -------------------------------
  await step("env-check", async () => {
    const need = ["SHOPIFY_SHOP", "SHOPIFY_TEST_THEME_ID"];
    const missing = need.filter((k) => !process.env[k]);
    const hasAdminAuth =
      !!process.env.SHOPIFY_OFFLINE_TOKEN ||
      (!!process.env.SHOPIFY_APP_KEY && !!process.env.SHOPIFY_APP_SECRET);
    if (!hasAdminAuth) missing.push("SHOPIFY_OFFLINE_TOKEN (or SHOPIFY_APP_KEY + SHOPIFY_APP_SECRET)");
    const hasLlm = !!process.env.HEROKU_INFERENCE_URL && !!process.env.HEROKU_INFERENCE_KEY;
    if (!hasLlm) missing.push("HEROKU_INFERENCE_URL + HEROKU_INFERENCE_KEY");
    if (missing.length) throw new Error(`missing env: ${missing.join(", ")}`);
    const set = ["SHOPIFY_SHOP", "SHOPIFY_TEST_THEME_ID", "SHOPIFY_OFFLINE_TOKEN", "SHOPIFY_APP_KEY", "SHOPIFY_STOREFRONT_PASSWORD", "HEROKU_INFERENCE_URL"]
      .filter((k) => process.env[k]);
    log(`  set: ${set.join(", ")}`);
  }).catch(() => fail(2, "env-check failed — fix .env.local and re-run"));

  const shop = normalizeShop(process.env.SHOPIFY_SHOP!);
  const testThemeId = Number(process.env.SHOPIFY_TEST_THEME_ID);
  const previewUrl = `${url}${url.includes("?") ? "&" : "?"}preview_theme_id=${testThemeId}`;

  // ---- step 2: theme-safety (refuse to write to a published theme) --------
  const themes = await step("theme-safety", async () => {
    const all = await themesList();
    const test = all.find((t) => t.id === testThemeId);
    const published = all.find((t) => t.role === "main");
    if (!test) throw new Error(`SHOPIFY_TEST_THEME_ID=${testThemeId} not found on ${shop}`);
    if (test.role === "main")
      throw new Error(
        `refusing to write: SHOPIFY_TEST_THEME_ID=${testThemeId} ("${test.name}") is the PUBLISHED theme`
      );
    return { test, published };
  }).catch((e) => fail(2, e instanceof Error ? e.message : String(e)));

  // ---- topology banner -----------------------------------------------------
  console.log(`
================== SMOKE TOPOLOGY ==================
STORE      ${shop}                       (SHOPIFY_SHOP)
READ FROM  published theme ${themes.published ? `${themes.published.id} "${themes.published.name}"` : "(none found?)"} — plain URL, before-state
INJECT TO  test theme      ${themes.test.id} "${themes.test.name}" role=${themes.test.role} (SHOPIFY_TEST_THEME_ID)
VERIFY AT  ${previewUrl}
MODE       ${dryRun ? "DRY-RUN (no theme writes at all)" : "LIVE env-mode (writes ONLY the test theme)"}
NOTE       the plain product URL will NOT change in env mode — check VERIFY AT
====================================================
`);

  // ---- step 3: before-snapshot (published theme, plain URL) ----------------
  await step("before-snapshot", async () => {
    const cookie = await getStorefrontCookie(shop);
    const r = await fetchPage(url, cookie ? { headers: { Cookie: cookie } } : {});
    if (r.error || !r.html) throw new Error(r.error ?? "empty response — is the URL right?");
    printJsonLd("BEFORE (published theme, plain URL)", extractJsonLd(r.html));
  }).catch((e) => fail(2, `could not fetch the product page: ${e instanceof Error ? e.message : e}`));

  // ---- step 4: runGoal (the real pipeline) ---------------------------------
  const goal: Goal = {
    siteId: "smoke-cli", // not a real site row: per-site context degrades to env creds by design
    target: { scope: "url_list", urls: [url], requireTypes: ["Product"], minOutcome: "rich_results_eligible" },
    constraints: { maxPages: 1, allowSchemaTypeChange: false, authoritative: false },
    autonomy: "auto_apply",
  };
  const result = await step(dryRun ? "runGoal (dry-run)" : "runGoal (live env-mode)", () =>
    runGoal(goal, {
      dryRun,
      persistAudit: false,
      concurrency: 1,
      writeTheme: { mode: "env" },
      onProgress: (ev: AgentProgressEvent) => {
        const bits = [
          ev.step ? `${ev.step} ${ev.status ?? ""}`.trim() : `phase=${ev.phase}`,
          ev.durationMs != null ? `(${(ev.durationMs / 1000).toFixed(1)}s)` : "",
          ev.url ? ev.url.replace(/^https?:\/\/[^/]+/, "") : "",
          ev.outcome ? `outcome=${ev.outcome}` : "",
          ev.gates ? gateLine(ev.gates) : "",
          ev.applyStatus ? `apply=${ev.applyStatus}` : "",
          ev.detail ?? "",
          ev.message ?? "",
        ].filter(Boolean);
        log(" ", ...bits);
      },
    })
  ).catch((e) => fail(1, `runGoal threw: ${e instanceof Error ? e.message : e}`));

  // ---- step 5: result -------------------------------------------------------
  console.log("\n================== RESULT ==================");
  console.log(`status=${result.status}  satisfied=${result.satisfied.length}  unsatisfied=${result.unsatisfied.length}`);
  const acted = result.actions.find((a) => a.url === url && a.gates);
  if (acted?.gates) console.log(`gates: ${gateLine(acted.gates as GateResults)}`);
  if (acted?.schemaAfter != null) {
    const after = Array.isArray(acted.schemaAfter) ? acted.schemaAfter : [acted.schemaAfter];
    printJsonLd("AFTER (generated JSON-LD)", after.map((parsed) => ({ parsed })));
  } else if (result.stagedSnippet) {
    const excerpt = result.stagedSnippet.slice(0, 1500);
    console.log(`\n--- staged snippet (excerpt) ---\n${excerpt}${result.stagedSnippet.length > 1500 ? "\n…" : ""}`);
  }

  if (dryRun) {
    console.log("\nDRY-RUN: nothing was written. Re-run without --dry-run to inject + verify.");
  } else {
    const l4 = result.apply?.l4 ?? [];
    console.log(`\napply=${result.apply?.status ?? "(none)"}  writeTarget=${result.apply?.writeTarget ?? "-"}  L4 ${l4.filter((v) => v?.passed).length}/${l4.length} passed`);
    if (result.apply?.error) console.log(`apply error: ${result.apply.error}`);
  }

  console.log("\n--- summary ---");
  for (const s of summary) console.log(`  ${s.ok ? "✓" : "✗"} ${s.step.padEnd(24)} ${s.secs}s ${s.note ?? ""}`);

  console.log(`
EYEBALL IT YOURSELF:
  1. open  ${previewUrl}
     → view-source, search for "application/ld+json" — your product's schema is there.
     (the PLAIN url ${url} will NOT show it — env mode never touches the published theme)
  2. Google Rich Results test:
     https://search.google.com/test/rich-results?url=${encodeURIComponent(previewUrl)}
`);

  const ok = dryRun
    ? result.status === "done" && result.satisfied.length >= 1
    : result.status === "done" && result.apply?.status === "applied";
  if (!ok) {
    const why =
      result.haltedBy ? `breaker: ${result.haltedBy}` :
      result.killed ? "killed" :
      result.apply?.status ? `apply=${result.apply.status} ${result.apply.error ?? ""}` :
      result.unsatisfied.length ? `unsatisfied: ${result.unsatisfied.join(", ")}` :
      `status=${result.status}`;
    fail(1, `pipeline did not go green — ${why}`);
  }
  console.log(`${stamp()} ✓ SMOKE GREEN in ${elapsed()}`);
}

main().catch((e) => fail(1, e instanceof Error ? (e.stack ?? e.message) : String(e)));
